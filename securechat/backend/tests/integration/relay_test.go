//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/events"
	kafkaplatform "github.com/securechat/backend/internal/platform/kafka"
	"github.com/securechat/backend/internal/store"
	"github.com/twmb/franz-go/pkg/kgo"
)

func TestRelaySeesLateCommittedOutbox(t *testing.T) {
	f := newFixture(t)
	tx, e := f.pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	envelope, e := events.New(events.TypeMessageAccepted, events.MessageAccepted{MessageID: uuid.New(), ConversationID: uuid.New(), Seq: 1, SenderID: f.a, Recipients: []uuid.UUID{f.b}, Ciphertext: []byte{1}, AcceptedAt: time.Now()}, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	if e = store.InsertOutbox(ctx, tx, "chat.messages", uuid.NewString(), envelope); e != nil {
		t.Fatal(e)
	}
	if _, e = f.svc.Send(ctx, f.command("commits-first")); e != nil {
		t.Fatal(e)
	}
	pub := &recordingPublisher{}
	cancel, done := startRelay(t, f, pub)
	eventually(t, 3*time.Second, func() bool { return len(pub.snapshot()) == 1 })
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	eventually(t, 3*time.Second, func() bool { return len(pub.snapshot()) == 2 })
	cancel()
	<-done
	if number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) != 0 {
		t.Fatal("late committed older ID was skipped")
	}
}

type blockingPublisher struct {
	entered, cancelled chan struct{}
	calls              atomic.Int32
}

func (p *blockingPublisher) ProduceSync(op context.Context, records ...*kgo.Record) kgo.ProduceResults {
	if p.calls.Add(1) == 1 {
		close(p.entered)
	}
	<-op.Done()
	select {
	case p.cancelled <- struct{}{}:
	default:
	}
	return kgo.ProduceResults{{Record: records[0], Err: op.Err()}}
}
func TestRelayLockLossCancelsPublish(t *testing.T) {
	f := newFixture(t)
	if _, e := f.svc.Send(ctx, f.command("lock-loss")); e != nil {
		t.Fatal(e)
	}
	pub := &blockingPublisher{entered: make(chan struct{}), cancelled: make(chan struct{}, 1)}
	cancel, done := startRelay(t, f, pub)
	select {
	case <-pub.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("publish never began")
	}
	var terminated bool
	if e := f.pool.QueryRow(ctx, `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND objid=99191 AND granted`).Scan(&terminated); e != nil || !terminated {
		t.Fatalf("terminate lock holder: %v", e)
	}
	select {
	case <-pub.cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("lost leadership did not cancel publish")
	}
	cancel()
	<-done
	if number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) != 1 {
		t.Fatal("lost leader marked published")
	}
}

// A real unreachable broker tests the durable path without stopping a shared
// developer broker. scripts/verify-be1.ps1 also stops this project's real Kafka.
type switchPublisher struct {
	failed, live *kgo.Client
	recovered    atomic.Bool
}

func (p *switchPublisher) ProduceSync(op context.Context, r ...*kgo.Record) kgo.ProduceResults {
	if p.recovered.Load() {
		return p.live.ProduceSync(op, r...)
	}
	return p.failed.ProduceSync(op, r...)
}
func TestKafkaOutageBacklogDrains(t *testing.T) {
	f := newFixture(t)
	failed, e := kgo.NewClient(kgo.SeedBrokers("127.0.0.1:1"), kgo.RecordDeliveryTimeout(time.Second))
	if e != nil {
		t.Fatal(e)
	}
	defer failed.Close()
	live, e := kafkaplatform.NewProducer([]string{env("TEST_KAFKA_BROKERS", "localhost:9094")}, "outage-test")
	if e != nil {
		t.Fatal(e)
	}
	defer live.Close()
	p := &switchPublisher{failed: failed, live: live}
	cancel, done := startRelay(t, f, p)
	defer func() { cancel(); <-done }()
	for i := range 3 {
		if _, e = f.svc.Send(ctx, f.command(string(rune('a'+i)))); e != nil {
			t.Fatal(e)
		}
	}
	eventually(t, 3*time.Second, func() bool { return number(t, f.pool, `SELECT coalesce(sum(attempts),0) FROM outbox`) > 0 })
	if number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) != 3 {
		t.Fatal("outage lost backlog")
	}
	page, e := f.svc.Sync(ctx, f.b, nil, 50)
	if e != nil || len(page) != 1 || len(page[0].Messages) != 3 {
		t.Fatalf("DB sync depends on Kafka: %v", e)
	}
	p.recovered.Store(true)
	eventually(t, 15*time.Second, func() bool { return number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) == 0 })
	rows, e := f.pool.Query(ctx, `SELECT key,payload FROM outbox ORDER BY id`)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var raw []byte
		if e = rows.Scan(&key, &raw); e != nil {
			t.Fatal(e)
		}
		var env events.Envelope
		if e = json.Unmarshal(raw, &env); e != nil || key != f.conv.String() || env.EventType != events.TypeMessageAccepted {
			t.Fatal("event contract changed")
		}
	}
}
