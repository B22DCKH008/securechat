package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/events"
	"github.com/twmb/franz-go/pkg/kgo"
)

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// fakeLog models one consumer group on in-memory partitions: a fetch position
// that advances on poll and can be rewound by SetOffsets, plus committed offsets.
type fakeLog struct {
	topic     string
	parts     map[int32][]*kgo.Record
	pos       map[int32]int64
	committed map[int32]int64
	rewinds   int
}

func newFakeLog(topic string) *fakeLog {
	return &fakeLog{topic: topic, parts: map[int32][]*kgo.Record{}, pos: map[int32]int64{}, committed: map[int32]int64{}}
}

func (l *fakeLog) append(p int32, value []byte, headers ...kgo.RecordHeader) {
	off := int64(len(l.parts[p]))
	l.parts[p] = append(l.parts[p], &kgo.Record{Topic: l.topic, Partition: p, Offset: off, Key: []byte("conv"), Value: value, Headers: headers})
}

func (l *fakeLog) PollFetches(context.Context) kgo.Fetches {
	ft := kgo.FetchTopic{Topic: l.topic}
	for p := int32(0); p < int32(len(l.parts)); p++ {
		recs := l.parts[p][l.pos[p]:]
		l.pos[p] = int64(len(l.parts[p]))
		ft.Partitions = append(ft.Partitions, kgo.FetchPartition{Partition: p, Records: recs})
	}
	return kgo.Fetches{{Topics: []kgo.FetchTopic{ft}}}
}

func (l *fakeLog) CommitRecords(_ context.Context, rs ...*kgo.Record) error {
	for _, r := range rs {
		if r.Offset+1 > l.committed[r.Partition] {
			l.committed[r.Partition] = r.Offset + 1
		}
	}
	return nil
}

func (l *fakeLog) SetOffsets(m map[string]map[int32]kgo.EpochOffset) {
	for p, eo := range m[l.topic] {
		l.pos[p] = eo.Offset
		l.rewinds++
	}
}
func (l *fakeLog) AllowRebalance() {}

type fakeProducer struct {
	mu   sync.Mutex
	fail bool
	sent []*kgo.Record
}

func (p *fakeProducer) ProduceSync(_ context.Context, rs ...*kgo.Record) kgo.ProduceResults {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out kgo.ProduceResults
	for _, r := range rs {
		if p.fail {
			out = append(out, kgo.ProduceResult{Record: r, Err: errors.New("broker unavailable")})
			continue
		}
		p.sent = append(p.sent, r)
		out = append(out, kgo.ProduceResult{Record: r})
	}
	return out
}

func (p *fakeProducer) topics() []string {
	var t []string
	for _, r := range p.sent {
		t = append(t, r.Topic)
	}
	return t
}

func messageEvent(t *testing.T, rcpt uuid.UUID) []byte {
	t.Helper()
	env, err := events.New(events.TypeMessageAccepted, events.MessageAccepted{
		MessageID: uuid.New(), Recipients: []uuid.UUID{rcpt}, AcceptedAt: time.Now()}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	return raw
}

// poisonEvent has a valid envelope/eventId but an invalid typed payload.
func poisonEvent(t *testing.T) ([]byte, uuid.UUID) {
	t.Helper()
	id := uuid.New()
	raw, _ := json.Marshal(map[string]any{"eventId": id, "eventType": events.TypeMessageAccepted,
		"schemaVersion": 1, "occurredAt": time.Now(), "payload": json.RawMessage(`{"messageId":"not-a-uuid"}`)})
	return raw, id
}

func TestDLQFailureKeepsPoisonOffsetAndReplays(t *testing.T) {
	bob := uuid.New()
	src := newFakeLog("chat.messages")
	poison, poisonID := poisonEvent(t)
	src.append(0, poison)
	src.append(0, messageEvent(t, bob)) // must not be committed past the poison
	src.append(0, []byte("{malformed envelope"))
	src.append(1, messageEvent(t, bob)) // other partition keeps progressing

	pusher := &fakePusher{got: map[uuid.UUID]int{}}
	router := NewRouter(pusher, 100)
	prod := &fakeProducer{fail: true}
	k := NewKafkaConsumer(src, prod, router, "chat.dlq", quietLog)

	for i := 0; i < 3; i++ { // repeated polls while the DLQ stays down
		if !k.processFetches(context.Background(), src.PollFetches(context.Background())) {
			t.Fatal("blocked partition not reported")
		}
		if src.committed[0] != 0 {
			t.Fatalf("poll %d: committed partition 0 to %d past failed poison", i, src.committed[0])
		}
		if src.committed[1] != 1 {
			t.Fatalf("partition 1 did not progress: %d", src.committed[1])
		}
		if src.pos[0] != 0 {
			t.Fatalf("fetch position not rewound to poison: %d", src.pos[0])
		}
	}
	if router.dedupe.Seen(poisonID) {
		t.Fatal("failed poison eventId remembered by dedupe")
	}
	if pusher.got[bob] != 1 { // only partition 1's event so far
		t.Fatalf("pushes before recovery = %d, want 1", pusher.got[bob])
	}

	prod.fail = false // DLQ restored without restart
	if k.processFetches(context.Background(), src.PollFetches(context.Background())) {
		t.Fatal("still blocked after DLQ recovery")
	}
	if src.committed[0] != 3 {
		t.Fatalf("partition 0 committed to %d, want 3", src.committed[0])
	}
	if got := prod.topics(); len(got) != 2 || got[0] != "chat.dlq" || got[1] != "chat.dlq" {
		t.Fatalf("DLQ copies = %v, want poison and malformed envelope", got)
	}
	if string(prod.sent[0].Value) != string(poison) || headerValue(prod.sent[0], HeaderSourceTopic) != "chat.messages" ||
		headerValue(prod.sent[0], HeaderDLQReason) != "permanent" {
		t.Fatal("DLQ copy changed value or lacks source/reason headers")
	}
	if pusher.got[bob] != 2 {
		t.Fatalf("pushes after recovery = %d, want 2", pusher.got[bob])
	}
}

// Restart: a new consumer over the same committed offsets replays the poison.
func TestRestartAfterDLQFailureReplaysFromCommit(t *testing.T) {
	src := newFakeLog("chat.messages")
	poison, _ := poisonEvent(t)
	src.append(0, poison)
	src.append(0, messageEvent(t, uuid.New()))
	prod := &fakeProducer{fail: true}
	NewKafkaConsumer(src, prod, NewRouter(&fakePusher{got: map[uuid.UUID]int{}}, 10), "chat.dlq", quietLog).
		processFetches(context.Background(), src.PollFetches(context.Background()))

	// Simulated restart: fresh router/dedupe, position = committed offset.
	src.pos[0] = src.committed[0]
	prod.fail = false
	pusher := &fakePusher{got: map[uuid.UUID]int{}}
	NewKafkaConsumer(src, prod, NewRouter(pusher, 10), "chat.dlq", quietLog).
		processFetches(context.Background(), src.PollFetches(context.Background()))
	if len(prod.sent) != 1 || src.committed[0] != 2 || len(pusher.got) != 1 {
		t.Fatalf("dlq=%d committed=%d pushed=%v", len(prod.sent), src.committed[0], pusher.got)
	}
}

type flakyHandler struct {
	failures int // transient failures before success
	calls    int
}

func (h *flakyHandler) Handle([]byte) error {
	h.calls++
	if h.calls <= h.failures {
		return errors.New("downstream temporarily unavailable")
	}
	return nil
}

func TestTransientWithoutRetryTopicBlocksInPlace(t *testing.T) {
	src := newFakeLog("chat.messages")
	src.append(0, []byte("a"))
	src.append(0, []byte("b"))
	h := &flakyHandler{failures: 1}
	k := NewKafkaConsumer(src, &fakeProducer{}, h, "chat.dlq", quietLog)
	if !k.processFetches(context.Background(), src.PollFetches(context.Background())) || src.committed[0] != 0 {
		t.Fatal("transient failure was committed")
	}
	if k.processFetches(context.Background(), src.PollFetches(context.Background())) || src.committed[0] != 2 {
		t.Fatalf("replay did not complete: committed %d", src.committed[0])
	}
}

func TestTransientGoesThroughRetryTopicThenDLQ(t *testing.T) {
	policy := RetryPolicy{Topic: "chat.retry", Group: "gw-A.retry", MaxAttempts: 3, BaseDelay: 10 * time.Millisecond, MaxDelay: 40 * time.Millisecond}
	src := newFakeLog("chat.messages")
	src.append(0, []byte("event"))
	h := &flakyHandler{failures: 100} // never recovers
	prod := &fakeProducer{}
	main := NewKafkaConsumer(src, prod, h, "chat.dlq", quietLog).WithRetry(policy)
	if main.processFetches(context.Background(), src.PollFetches(context.Background())) || src.committed[0] != 1 {
		t.Fatal("source record not committed after durable retry copy")
	}

	retryLog := newFakeLog("chat.retry")
	var slept []time.Duration
	rc := NewRetryConsumer(retryLog, prod, h, "chat.dlq", policy, quietLog)
	rc.sleep = func(_ context.Context, d time.Duration) { slept = append(slept, d) }
	// Another instance's retry must be skipped and committed.
	retryLog.append(0, []byte("foreign"), kgo.RecordHeader{Key: HeaderRetryGroup, Value: []byte("gw-B.retry")})

	for n := 0; n < len(prod.sent); n++ { // feed produced retry copies back in
		r := prod.sent[n]
		if r.Topic != "chat.retry" {
			continue
		}
		retryLog.append(0, r.Value, r.Headers...)
		rc.processFetches(context.Background(), retryLog.PollFetches(context.Background()))
	}
	topics := prod.topics()
	want := []string{"chat.retry", "chat.retry", "chat.dlq"}
	if len(topics) != len(want) {
		t.Fatalf("produced %v, want %v", topics, want)
	}
	for i := range want {
		if topics[i] != want[i] {
			t.Fatalf("produced %v, want %v", topics, want)
		}
	}
	last := prod.sent[2]
	if headerValue(last, HeaderDLQReason) != "retries_exhausted" || headerValue(last, HeaderSourceTopic) != "chat.messages" {
		t.Fatal("exhausted retry lacks reason/source headers")
	}
	if a, _ := strconv.Atoi(headerValue(prod.sent[1], HeaderRetryAttempt)); a != 2 {
		t.Fatalf("second retry attempt header = %d", a)
	}
	if h.calls != 3 { // source + 2 retries; foreign record never handled
		t.Fatalf("handler calls = %d, want 3", h.calls)
	}
	if retryLog.committed[0] != int64(len(retryLog.parts[0])) {
		t.Fatal("retry consumer left completed records uncommitted")
	}
	for _, d := range slept {
		if d > policy.MaxDelay {
			t.Fatalf("waited %v beyond MaxDelay", d)
		}
	}
}

func TestRetryPublishFailureBlocksSource(t *testing.T) {
	src := newFakeLog("chat.messages")
	src.append(0, []byte("event"))
	prod := &fakeProducer{fail: true}
	k := NewKafkaConsumer(src, prod, &flakyHandler{failures: 100}, "chat.dlq", quietLog).
		WithRetry(RetryPolicy{Topic: "chat.retry", Group: "g", MaxAttempts: 3})
	if !k.processFetches(context.Background(), src.PollFetches(context.Background())) || src.committed[0] != 0 {
		t.Fatal("committed although the retry copy was not acknowledged")
	}
}

func TestRetryDelayBounds(t *testing.T) {
	for attempt := 1; attempt <= 10; attempt++ {
		for i := 0; i < 50; i++ {
			d := retryDelay(100*time.Millisecond, time.Second, attempt)
			if d <= 0 || d > time.Second {
				t.Fatalf("attempt %d delay %v out of bounds", attempt, d)
			}
		}
	}
}

func TestWithHeadersDoesNotAliasSource(t *testing.T) {
	src := []kgo.RecordHeader{{Key: "eventId", Value: []byte("x")}, {Key: HeaderRetryAttempt, Value: []byte("1")}}
	out := withHeaders(src, HeaderRetryAttempt, "2")
	if string(src[1].Value) != "1" || len(out) != 2 || string(out[1].Value) != "2" {
		t.Fatalf("headers %v / %v", src, out)
	}
}

// A cancelled Run must still release the rebalance block or Close hangs.
type countingAllow struct {
	*fakeLog
	allowed int
}

func (c *countingAllow) AllowRebalance() { c.allowed++ }

func TestRunAllowsRebalanceOnExit(t *testing.T) {
	c := &countingAllow{fakeLog: newFakeLog("chat.messages")}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	NewKafkaConsumer(c, &fakeProducer{}, NewRouter(&fakePusher{got: map[uuid.UUID]int{}}, 1), "chat.dlq", quietLog).Run(ctx)
	if c.allowed == 0 {
		t.Fatal("Run returned without AllowRebalance")
	}
}
