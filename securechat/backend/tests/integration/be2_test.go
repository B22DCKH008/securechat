//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/securechat/backend/internal/delivery"
	"github.com/securechat/backend/internal/events"
	kafkaplatform "github.com/securechat/backend/internal/platform/kafka"
	"github.com/securechat/backend/internal/presence"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

func brokers() []string { return []string{env("TEST_KAFKA_BROKERS", "localhost:9094")} }

// switchProducer forwards to a real producer unless failing is set.
type switchProducer struct {
	real    *kgo.Client
	failing atomic.Bool
}

func (p *switchProducer) ProduceSync(op context.Context, rs ...*kgo.Record) kgo.ProduceResults {
	if p.failing.Load() {
		out := make(kgo.ProduceResults, 0, len(rs))
		for _, r := range rs {
			out = append(out, kgo.ProduceResult{Record: r, Err: errors.New("injected DLQ outage")})
		}
		return out
	}
	return p.real.ProduceSync(op, rs...)
}

type safePusher struct {
	mu  sync.Mutex
	got map[uuid.UUID]int
}

func (p *safePusher) PushToUser(id uuid.UUID, _ []byte) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.got[id]++
	return 1
}
func (p *safePusher) count(id uuid.UUID) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.got[id]
}

func acceptedEvent(t *testing.T, rcpt uuid.UUID) []byte {
	t.Helper()
	env, err := events.New(events.TypeMessageAccepted, events.MessageAccepted{MessageID: uuid.New(), Recipients: []uuid.UUID{rcpt}, AcceptedAt: time.Now()}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	return raw
}

func poison(t *testing.T) []byte {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"eventId": uuid.New(), "eventType": "MessageAccepted", "schemaVersion": 1,
		"occurredAt": time.Now(), "payload": json.RawMessage(`{"recipients":"not-a-list"}`)})
	return raw
}

type kafkaEnv struct {
	admin    *kadm.Client
	producer *kgo.Client // manual partitioner for deterministic placement
	src, dlq string
}

func newKafkaEnv(t *testing.T) *kafkaEnv {
	t.Helper()
	cl, err := kgo.NewClient(kgo.SeedBrokers(brokers()...), kgo.RecordPartitioner(kgo.ManualPartitioner()), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cl.Close)
	k := &kafkaEnv{admin: kadm.NewClient(cl), producer: cl, src: "be2.src." + uuid.NewString()[:8], dlq: "be2.dlq." + uuid.NewString()[:8]}
	for topic, parts := range map[string]int32{k.src: 2, k.dlq: 1} {
		res, err := k.admin.CreateTopic(ctx, parts, 1, nil, topic)
		if err != nil || res.Err != nil {
			t.Fatalf("create %s: %v %v", topic, err, res.Err)
		}
	}
	t.Cleanup(func() { _, _ = k.admin.DeleteTopics(ctx, k.src, k.dlq) })
	return k
}

func (k *kafkaEnv) put(t *testing.T, partition int32, value []byte) {
	t.Helper()
	if err := k.producer.ProduceSync(ctx, &kgo.Record{Topic: k.src, Partition: partition, Key: []byte("c"), Value: value}).FirstErr(); err != nil {
		t.Fatal(err)
	}
}

func (k *kafkaEnv) committed(t *testing.T, group string, partition int32) int64 {
	t.Helper()
	// The coordinator can be briefly unavailable right after broker start.
	var lastErr error
	for i := 0; i < 50; i++ {
		offs, err := k.admin.FetchOffsets(ctx, group)
		if err == nil {
			if o, ok := offs.Lookup(k.src, partition); ok && o.Err == nil {
				return o.At
			}
			return 0
		}
		lastErr = err
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("fetch offsets: %v", lastErr)
	return 0
}

func (k *kafkaEnv) dlqCount(t *testing.T) int64 {
	t.Helper()
	ends, err := k.admin.ListEndOffsets(ctx, k.dlq)
	if err != nil {
		t.Fatal(err)
	}
	o, _ := ends.Lookup(k.dlq, 0)
	return o.Offset
}

// startConsumer runs a real gateway consumer; the returned func stops it and
// closes the client (a process restart from Kafka's point of view).
func (k *kafkaEnv) startConsumer(t *testing.T, group string, pusher delivery.Pusher, pub delivery.RecordProducer) func() {
	t.Helper()
	cl, err := kafkaplatform.NewGatewayConsumer(brokers(), group, false, false, k.src)
	if err != nil {
		t.Fatal(err)
	}
	op, cancel := context.WithCancel(ctx)
	kc := delivery.NewKafkaConsumer(cl, pub, delivery.NewRouter(pusher, 1000), k.dlq, quiet)
	done := make(chan struct{})
	go func() { defer close(done); kc.Run(op) }()
	var once sync.Once
	stop := func() { once.Do(func() { cancel(); <-done; cl.Close() }) }
	t.Cleanup(stop)
	return stop
}

// TestDLQOutageDoesNotCommitPastPoison is the BE1 handoff P1 acceptance case
// (KF5/KF6/KF11) on a real broker, isolated topics and a dedicated group.
func TestDLQOutageDoesNotCommitPastPoison(t *testing.T) {
	k := newKafkaEnv(t)
	group := "be2-dlq-" + uuid.NewString()[:8]
	bob := uuid.New()
	pusher := &safePusher{got: map[uuid.UUID]int{}}
	real, err := kafkaplatform.NewProducer(brokers(), "be2-dlq-producer")
	if err != nil {
		t.Fatal(err)
	}
	defer real.Close()
	pub := &switchProducer{real: real}
	pub.failing.Store(true)

	k.put(t, 0, poison(t))
	k.put(t, 0, acceptedEvent(t, bob))      // after the poison, same partition
	k.put(t, 0, []byte("{not an envelope")) // malformed, no usable eventId
	k.put(t, 1, acceptedEvent(t, bob))      // independent partition

	stop := k.startConsumer(t, group, pusher, pub)
	eventually(t, 20*time.Second, func() bool { return k.committed(t, group, 1) == 1 })
	// Several blocked replays happen while the DLQ is down; offset must stay put.
	time.Sleep(2 * time.Second)
	if c := k.committed(t, group, 0); c != 0 {
		t.Fatalf("committed partition 0 to %d while DLQ publish failed", c)
	}
	if pusher.count(bob) != 1 || k.dlqCount(t) != 0 {
		t.Fatalf("pushes=%d dlq=%d before recovery", pusher.count(bob), k.dlqCount(t))
	}

	// Restore DLQ without restart: replay reaches the DLQ and the later event is handled.
	pub.failing.Store(false)
	eventually(t, 20*time.Second, func() bool { return k.committed(t, group, 0) == 3 })
	if k.dlqCount(t) != 2 || pusher.count(bob) != 2 {
		t.Fatalf("dlq=%d pushes=%d after recovery, want 2/2", k.dlqCount(t), pusher.count(bob))
	}

	// Restart case: fail again, block, stop the process, restore, start a new one.
	pub.failing.Store(true)
	k.put(t, 0, poison(t))
	k.put(t, 0, acceptedEvent(t, bob))
	time.Sleep(2 * time.Second)
	stop()
	if c := k.committed(t, group, 0); c != 3 {
		t.Fatalf("committed %d past the second poison before restart", c)
	}
	pub.failing.Store(false)
	pusher2 := &safePusher{got: map[uuid.UUID]int{}}
	stop2 := k.startConsumer(t, group, pusher2, pub)
	eventually(t, 30*time.Second, func() bool { return k.committed(t, group, 0) == 5 })
	if k.dlqCount(t) != 3 || pusher2.count(bob) != 1 {
		t.Fatalf("after restart dlq=%d pushes=%d, want 3/1", k.dlqCount(t), pusher2.count(bob))
	}
	stop2()

	// KF9: lag counts records produced while the group is stopped.
	for i := 0; i < 3; i++ {
		k.put(t, 1, acceptedEvent(t, bob))
	}
	lags, err := kafkaplatform.MeasureLag(ctx, k.admin, group)
	if err != nil {
		t.Fatal(err)
	}
	if got := lags[group][k.src]; got.Lag != 3 || got.Uncommitted != 0 {
		t.Fatalf("lag = %+v, want 3 committed-lag records", got)
	}
}

func redisClient(t *testing.T) *redis.Client {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: env("TEST_REDIS_ADDR", "localhost:6379"), DB: 0})
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Fatalf("Redis required (TEST_REDIS_ADDR): %v", err)
	}
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb
}

// RS14/RS29: per-connection expiry and dead-instance cleanup on real Redis 7.4.
func TestPresencePerConnectionTTLAndInstanceCleanup(t *testing.T) {
	rdb := redisClient(t)
	suffix := uuid.NewString()[:8]
	a := presence.NewRegistry(rdb, "be2-A-"+suffix, time.Second)
	b := presence.NewRegistry(rdb, "be2-B-"+suffix, time.Minute)
	user := uuid.New()
	t.Cleanup(func() { _, _ = a.CleanupInstance(ctx); _, _ = b.CleanupInstance(ctx) })

	for _, c := range []string{"idle", "alive"} {
		if err := a.Register(ctx, user, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.Register(ctx, user, "other"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(deadline) { // only "alive" heartbeats
		if err := a.Refresh(ctx, user, "alive"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(200 * time.Millisecond)
	}
	m, err := a.Lookup(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m["idle"]; ok || m["alive"] != "be2-A-"+suffix || m["other"] != "be2-B-"+suffix {
		t.Fatalf("after per-connection expiry: %v", m)
	}

	// Simulated crash of A: entries remain until A restarts and cleans up.
	n, err := a.CleanupInstance(ctx)
	if err != nil || n != 1 {
		t.Fatalf("cleanup removed %d, %v; want 1", n, err)
	}
	m, _ = a.Lookup(ctx, user)
	if len(m) != 1 || m["other"] == "" {
		t.Fatalf("cleanup touched another instance: %v", m)
	}
	if on, _ := b.IsOnline(ctx, user); !on {
		t.Fatal("user should remain online via instance B")
	}
	if err := b.Unregister(ctx, user, "other"); err != nil {
		t.Fatal(err)
	}
	if on, _ := b.IsOnline(ctx, user); on {
		t.Fatal("user still online after last unregister")
	}

	// Refresh recreates an entry lost from Redis (e.g. Redis restart).
	if err := a.Refresh(ctx, user, "alive"); err != nil {
		t.Fatal(err)
	}
	if m, _ = a.Lookup(ctx, user); m["alive"] == "" {
		t.Fatal("refresh did not recreate missing entry")
	}
}

// KF16 / EXP13: relay-side Redis publisher → subscriber → router on real Redis.
func TestRedisTransportPublisherToSubscriber(t *testing.T) {
	rdb := redisClient(t)
	channel := "be2.messages." + uuid.NewString()[:8]
	bob := uuid.New()
	pusher := &safePusher{got: map[uuid.UUID]int{}}
	sub := delivery.NewRedisSubscriber(rdb, delivery.NewRouter(pusher, 100), quiet, channel)
	op, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); sub.Run(op) }()
	defer func() { cancel(); <-done }()

	pub := delivery.NewRedisPublisher(rdb)
	event := acceptedEvent(t, bob)
	// Pub/Sub drops messages until the subscription is active; keep publishing
	// the same event (deduped by eventId) until it lands.
	eventually(t, 5*time.Second, func() bool {
		if err := pub.ProduceSync(ctx, &kgo.Record{Topic: channel, Value: event}).FirstErr(); err != nil {
			t.Fatal(err)
		}
		return pusher.count(bob) > 0
	})
	time.Sleep(200 * time.Millisecond)
	if c := pusher.count(bob); c != 1 {
		t.Fatalf("pushed %d times, want 1 (eventId dedupe)", c)
	}
}
