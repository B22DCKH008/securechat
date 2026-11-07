package delivery

import (
	"context"
	"errors"
	"log/slog"

	"github.com/securechat/backend/internal/metrics"
	"github.com/twmb/franz-go/pkg/kgo"
)

// KafkaConsumer is the gateway consumer: group = instance id (gw-A, gw-B).
type KafkaConsumer struct {
	client   *kgo.Client
	producer *kgo.Client // for DLQ; may be the relay producer
	router   *Router
	dlqTopic string
	log      *slog.Logger
}

func NewKafkaConsumer(client, producer *kgo.Client, router *Router, dlqTopic string, log *slog.Logger) *KafkaConsumer {
	return &KafkaConsumer{client: client, producer: producer, router: router, dlqTopic: dlqTopic,
		log: log.With("component", "kafka-consumer")}
}

// Run polls until ctx is cancelled. Offsets are committed only after the whole
// batch has been handled (pushed to local WS queues or sent to DLQ) – KF6.
func (k *KafkaConsumer) Run(ctx context.Context) {
	for {
		fetches := k.client.PollFetches(ctx)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return
		}
		fetches.EachError(func(topic string, p int32, err error) {
			k.log.Warn("fetch error", "topic", topic, "partition", p, "err", err)
		})

		var handled []*kgo.Record
		fetches.EachRecord(func(rec *kgo.Record) {
			metrics.EventsConsumed.WithLabelValues(rec.Topic).Inc()
			if err := k.router.Handle(rec.Value); err != nil {
				var perm PermanentError
				if errors.As(err, &perm) {
					k.sendToDLQ(ctx, rec, err)
				} else {
					// TODO(BE2, KF11): publish to chat.retry with attempt header and
					// exponential backoff + jitter instead of only logging.
					k.log.Warn("transient handle error", "topic", rec.Topic, "offset", rec.Offset, "err", err)
				}
			}
			handled = append(handled, rec)
		})
		if len(handled) == 0 {
			continue
		}
		if err := k.client.CommitRecords(ctx, handled...); err != nil && ctx.Err() == nil {
			// Not fatal: uncommitted records are re-delivered and deduped (KF5, KF10).
			k.log.Warn("commit failed", "err", err)
		}
	}
}

// sendToDLQ copies the poison record so it does not block the partition (KF11).
// The value is forwarded as-is (ciphertext only) – never decode/log it.
func (k *KafkaConsumer) sendToDLQ(ctx context.Context, rec *kgo.Record, cause error) {
	metrics.EventsDLQ.Inc()
	dlq := &kgo.Record{
		Topic: k.dlqTopic,
		Key:   rec.Key,
		Value: rec.Value,
		Headers: append(rec.Headers,
			kgo.RecordHeader{Key: "dlq.sourceTopic", Value: []byte(rec.Topic)},
			kgo.RecordHeader{Key: "dlq.error", Value: []byte(cause.Error())},
		),
	}
	if err := k.producer.ProduceSync(ctx, dlq).FirstErr(); err != nil {
		k.log.Error("dlq publish failed", "err", err, "topic", rec.Topic, "offset", rec.Offset)
	}
}
