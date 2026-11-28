package delivery

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"strconv"
	"time"

	"github.com/securechat/backend/internal/metrics"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Header keys written on chat.retry / chat.dlq copies. Values are never user content.
const (
	HeaderSourceTopic  = "dlq.sourceTopic"
	HeaderDLQReason    = "dlq.reason"
	HeaderRetryAttempt = "retry.attempt"
	HeaderRetryGroup   = "retry.group"
	HeaderRetryNotBef  = "retry.notBefore" // unix milliseconds
)

// FetchClient is the subset of *kgo.Client used by the consumer (fakeable in tests).
type FetchClient interface {
	PollFetches(context.Context) kgo.Fetches
	CommitRecords(context.Context, ...*kgo.Record) error
	SetOffsets(map[string]map[int32]kgo.EpochOffset)
	AllowRebalance()
}

// RecordProducer publishes DLQ / retry copies; *kgo.Client implements it.
type RecordProducer interface {
	ProduceSync(context.Context, ...*kgo.Record) kgo.ProduceResults
}

// EventHandler is implemented by *Router.
type EventHandler interface {
	Handle(raw []byte) error
}

// RetryPolicy configures the chat.retry path (KF11, RS36). A zero Topic disables
// it: transient failures then block the partition and are replayed in place.
type RetryPolicy struct {
	Topic       string
	Group       string // owner consumer group; other instances skip its retries
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// KafkaConsumer is the gateway consumer: group = instance id (gw-A, gw-B).
//
// Offset rule (KF6, KF11): per partition, only the contiguous prefix of records
// that completed (pushed locally, or durably copied to chat.retry/chat.dlq) is
// committed. If copying a failed record is not acknowledged by the broker, that
// partition stops at the failed offset, its fetch position is rewound, and the
// same record is replayed after a backoff. Other partitions keep progressing.
type KafkaConsumer struct {
	client   FetchClient
	producer RecordProducer
	router   EventHandler
	dlqTopic string
	retry    RetryPolicy
	isRetry  bool // consumes chat.retry instead of the source topics
	log      *slog.Logger
	now      func() time.Time
	sleep    func(context.Context, time.Duration)
}

func NewKafkaConsumer(client FetchClient, producer RecordProducer, router EventHandler, dlqTopic string, log *slog.Logger) *KafkaConsumer {
	return &KafkaConsumer{client: client, producer: producer, router: router, dlqTopic: dlqTopic,
		log: log.With("component", "kafka-consumer"), now: time.Now, sleep: sleepCtx}
}

// WithRetry routes transient failures through policy.Topic instead of blocking.
func (k *KafkaConsumer) WithRetry(p RetryPolicy) *KafkaConsumer {
	if p.MaxAttempts < 1 {
		p.MaxAttempts = 1
	}
	if p.BaseDelay <= 0 {
		p.BaseDelay = 500 * time.Millisecond
	}
	if p.MaxDelay < p.BaseDelay {
		p.MaxDelay = p.BaseDelay
	}
	k.retry = p
	return k
}

// NewRetryConsumer consumes policy.Topic for policy.Group only, waits until each
// record's notBefore time, re-handles it, and escalates to the DLQ after
// MaxAttempts. Records owned by other instances' groups are committed untouched.
func NewRetryConsumer(client FetchClient, producer RecordProducer, router EventHandler, dlqTopic string, p RetryPolicy, log *slog.Logger) *KafkaConsumer {
	k := NewKafkaConsumer(client, producer, router, dlqTopic, log).WithRetry(p)
	k.isRetry = true
	k.log = log.With("component", "kafka-retry-consumer")
	return k
}

// Run polls until ctx is cancelled or the client is closed.
func (k *KafkaConsumer) Run(ctx context.Context) {
	bo := consumerBackoff{base: 200 * time.Millisecond, max: 10 * time.Second}
	// With BlockRebalanceOnPoll every poll must be followed by AllowRebalance,
	// including the last one; otherwise Close/LeaveGroup blocks forever.
	defer k.client.AllowRebalance()
	for {
		fetches := k.client.PollFetches(ctx)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return
		}
		fetches.EachError(func(topic string, p int32, err error) {
			if !errors.Is(err, context.Canceled) {
				k.log.Warn("fetch error", "topic", topic, "partition", p, "err", err)
			}
		})
		blocked := k.processFetches(ctx, fetches)
		k.client.AllowRebalance()
		if blocked {
			k.sleep(ctx, bo.next())
		} else {
			bo.reset()
		}
	}
}

// processFetches handles one poll and reports whether any partition is blocked.
func (k *KafkaConsumer) processFetches(ctx context.Context, fetches kgo.Fetches) bool {
	var done []*kgo.Record
	rewind := map[string]map[int32]kgo.EpochOffset{}
	fetches.EachPartition(func(p kgo.FetchTopicPartition) {
		for _, rec := range p.Records {
			if err := k.process(ctx, rec); err != nil {
				if rewind[rec.Topic] == nil {
					rewind[rec.Topic] = map[int32]kgo.EpochOffset{}
				}
				rewind[rec.Topic][rec.Partition] = kgo.EpochOffset{Epoch: rec.LeaderEpoch, Offset: rec.Offset}
				metrics.ConsumerPartitionBlocked.Inc()
				if ctx.Err() == nil {
					k.log.Warn("partition blocked; record will be replayed", "topic", rec.Topic,
						"partition", rec.Partition, "offset", rec.Offset, "err", err)
				}
				return // later records of this partition stay uncommitted
			}
			done = append(done, rec)
		}
	})
	if len(done) > 0 {
		// CommitRecords commits offset+1 of the highest record per partition; done
		// only holds a contiguous completed prefix of each partition.
		if err := k.client.CommitRecords(ctx, done...); err != nil && ctx.Err() == nil {
			// Not fatal: uncommitted records are re-delivered and deduped (KF5, KF10).
			k.log.Warn("commit failed", "err", err)
		}
	}
	if len(rewind) > 0 {
		// Drop anything buffered after the failed record and fetch it again.
		k.client.SetOffsets(rewind)
	}
	return len(rewind) > 0
}

// process returns nil once rec is fully handled (and may be committed).
func (k *KafkaConsumer) process(ctx context.Context, rec *kgo.Record) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	metrics.EventsConsumed.WithLabelValues(rec.Topic).Inc()
	attempt := 0
	if k.isRetry {
		if headerValue(rec, HeaderRetryGroup) != k.retry.Group {
			return nil // another instance's retry
		}
		attempt, _ = strconv.Atoi(headerValue(rec, HeaderRetryAttempt))
		if ms, err := strconv.ParseInt(headerValue(rec, HeaderRetryNotBef), 10, 64); err == nil {
			wait := time.UnixMilli(ms).Sub(k.now())
			if wait > k.retry.MaxDelay {
				wait = k.retry.MaxDelay // bound a bogus/clock-skewed header
			}
			if wait > 0 {
				k.sleep(ctx, wait)
				if ctx.Err() != nil {
					return ctx.Err()
				}
			}
		}
	}

	err := k.router.Handle(rec.Value)
	if err == nil {
		return nil
	}
	var perm PermanentError
	if errors.As(err, &perm) {
		return k.toDLQ(ctx, rec, "permanent")
	}
	if k.retry.Topic == "" {
		return err // block and replay in place
	}
	if attempt+1 >= k.retry.MaxAttempts {
		return k.toDLQ(ctx, rec, "retries_exhausted")
	}
	return k.toRetry(ctx, rec, attempt+1)
}

// toDLQ copies the poison record so it does not block the partition (KF11).
// The value is forwarded as-is (ciphertext only) – never decode/log it. Only a
// broker-acknowledged copy lets the source offset be committed.
func (k *KafkaConsumer) toDLQ(ctx context.Context, rec *kgo.Record, reason string) error {
	dlq := &kgo.Record{
		Topic:   k.dlqTopic,
		Key:     rec.Key,
		Value:   rec.Value,
		Headers: withHeaders(rec.Headers, HeaderSourceTopic, sourceTopic(rec), HeaderDLQReason, reason),
	}
	if err := k.producer.ProduceSync(ctx, dlq).FirstErr(); err != nil {
		metrics.EventsDLQFailed.Inc()
		return errors.Join(errors.New("dlq publish failed"), err)
	}
	metrics.EventsDLQ.Inc()
	return nil
}

func (k *KafkaConsumer) toRetry(ctx context.Context, rec *kgo.Record, attempt int) error {
	notBefore := k.now().Add(retryDelay(k.retry.BaseDelay, k.retry.MaxDelay, attempt))
	r := &kgo.Record{
		Topic: k.retry.Topic,
		Key:   rec.Key, // keep conversationId partitioning
		Value: rec.Value,
		Headers: withHeaders(rec.Headers,
			HeaderSourceTopic, sourceTopic(rec),
			HeaderRetryGroup, k.retry.Group,
			HeaderRetryAttempt, strconv.Itoa(attempt),
			HeaderRetryNotBef, strconv.FormatInt(notBefore.UnixMilli(), 10)),
	}
	if err := k.producer.ProduceSync(ctx, r).FirstErr(); err != nil {
		return errors.Join(errors.New("retry publish failed"), err)
	}
	metrics.EventsRetried.Inc()
	return nil
}

// retryDelay is exponential backoff with full jitter in [base/2, cap].
func retryDelay(base, maxDelay time.Duration, attempt int) time.Duration {
	d := base
	for i := 1; i < attempt && d < maxDelay; i++ {
		d *= 2
	}
	d = min(d, maxDelay)
	half := d / 2
	return half + time.Duration(rand.Int64N(int64(d-half)+1))
}

func sourceTopic(rec *kgo.Record) string {
	if v := headerValue(rec, HeaderSourceTopic); v != "" {
		return v
	}
	return rec.Topic
}

func headerValue(rec *kgo.Record, key string) string {
	for i := len(rec.Headers) - 1; i >= 0; i-- {
		if rec.Headers[i].Key == key {
			return string(rec.Headers[i].Value)
		}
	}
	return ""
}

// withHeaders returns a copy of h with kv pairs replaced/added (never aliases h).
func withHeaders(h []kgo.RecordHeader, kv ...string) []kgo.RecordHeader {
	out := make([]kgo.RecordHeader, 0, len(h)+len(kv)/2)
	for _, x := range h {
		replaced := false
		for i := 0; i+1 < len(kv); i += 2 {
			if x.Key == kv[i] {
				replaced = true
				break
			}
		}
		if !replaced {
			out = append(out, x)
		}
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out = append(out, kgo.RecordHeader{Key: kv[i], Value: []byte(kv[i+1])})
	}
	return out
}

type consumerBackoff struct{ base, max, cur time.Duration }

func (b *consumerBackoff) next() time.Duration {
	if b.cur == 0 {
		b.cur = b.base
	} else {
		b.cur = min(b.cur*2, b.max)
	}
	return b.cur/2 + time.Duration(rand.Int64N(int64(b.cur/2)+1))
}
func (b *consumerBackoff) reset() { b.cur = 0 }

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
