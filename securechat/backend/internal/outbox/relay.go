// Package outbox implements the polling outbox relay (KF1, KF2, KF3, KF8, KF15).
//
//	PostgreSQL outbox ──(poll, id order)──► Kafka (acks=all) ──► mark published_at
//
// Only one relay is active cluster-wide, enforced by a PostgreSQL session-level
// advisory lock. Every instance runs the loop; non-leaders just wait.
// Crash between broker ack and MarkPublished ⇒ re-publish ⇒ consumers dedupe (KF5).
package outbox

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/metrics"
	"github.com/securechat/backend/internal/store"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Publisher abstracts the broker so the relay can be unit-tested and so the
// Redis Pub/Sub transport can be swapped in for EXP13 (KF16).
type Publisher interface {
	ProduceSync(ctx context.Context, rs ...*kgo.Record) kgo.ProduceResults
}

type Config struct {
	PollInterval time.Duration
	BatchSize    int
	LockID       int64
	Retention    time.Duration
}

type Relay struct {
	pool *pgxpool.Pool
	pub  Publisher
	cfg  Config
	log  *slog.Logger
}

func NewRelay(pool *pgxpool.Pool, pub Publisher, cfg Config, log *slog.Logger) *Relay {
	return &Relay{pool: pool, pub: pub, cfg: cfg, log: log.With("component", "outbox-relay")}
}

// Run blocks until ctx is cancelled.
func (r *Relay) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := r.leadAndRelay(ctx); err != nil && ctx.Err() == nil {
			r.log.Warn("relay loop error", "err", err)
		}
		sleep(ctx, 2*time.Second) // retry acquiring leadership
	}
}

func (r *Relay) leadAndRelay(ctx context.Context) error {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, r.cfg.LockID).Scan(&got); err != nil {
		return err
	}
	if !got {
		metrics.RelayLeader.Set(0)
		return nil
	}
	r.log.Info("acquired relay leadership")
	metrics.RelayLeader.Set(1)
	defer func() {
		metrics.RelayLeader.Set(0)
		// Unlock on a fresh context: ctx may already be cancelled at shutdown.
		uctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = conn.Exec(uctx, `SELECT pg_advisory_unlock($1)`, r.cfg.LockID)
	}()

	backoff := newBackoff(100*time.Millisecond, 10*time.Second)
	purgeTicker := time.NewTicker(time.Minute)
	defer purgeTicker.Stop()

	for ctx.Err() == nil {
		// Lock is tied to this session; if the connection died we lost leadership.
		if err := conn.Ping(ctx); err != nil {
			return err
		}
		select {
		case <-purgeTicker.C:
			r.purge(ctx)
		default:
		}

		n, err := r.relayOnce(ctx)
		if err != nil {
			metrics.OutboxPublishErrors.Inc()
			d := backoff.next()
			r.log.Warn("publish failed; backing off", "err", err, "backoff", d)
			sleep(ctx, d)
			continue
		}
		backoff.reset()
		if n == 0 {
			sleep(ctx, r.cfg.PollInterval)
		}
	}
	return ctx.Err()
}

// relayOnce publishes one batch. Only the contiguous successful prefix is marked,
// so a failure never lets a later event overtake an earlier one in the outbox.
func (r *Relay) relayOnce(ctx context.Context) (int, error) {
	rows, err := store.FetchUnpublished(ctx, r.pool, r.cfg.BatchSize)
	if err != nil {
		return 0, err
	}
	if backlog, err := store.OutboxBacklog(ctx, r.pool); err == nil {
		metrics.OutboxBacklog.Set(float64(backlog))
	}
	if len(rows) == 0 {
		return 0, nil
	}

	recs := make([]*kgo.Record, len(rows))
	for i, row := range rows {
		recs[i] = &kgo.Record{
			Topic: row.Topic,
			Key:   []byte(row.Key),
			Value: row.Payload,
			Headers: []kgo.RecordHeader{
				{Key: "eventId", Value: []byte(row.EventID)},
				{Key: "eventType", Value: []byte(row.EventType)},
			},
		}
	}
	results := r.pub.ProduceSync(ctx, recs...)

	now := time.Now().UTC()
	ok := make([]int64, 0, len(rows))
	var firstErr error
	for i, res := range results {
		if res.Err != nil {
			firstErr = res.Err
			_ = store.RecordOutboxFailure(ctx, r.pool, rows[i].ID, res.Err.Error())
			break
		}
		ok = append(ok, rows[i].ID)
		metrics.StageAcceptedToPublished.Observe(now.Sub(rows[i].CreatedAt).Seconds())
	}
	if err := store.MarkPublished(ctx, r.pool, ok, now); err != nil {
		return 0, err
	}
	metrics.OutboxPublished.Add(float64(len(ok)))
	return len(ok), firstErr
}

func (r *Relay) purge(ctx context.Context) {
	n, err := store.PurgePublishedOutbox(ctx, r.pool, time.Now().Add(-r.cfg.Retention))
	if err != nil {
		r.log.Warn("outbox purge failed", "err", err)
		return
	}
	if n > 0 {
		r.log.Info("outbox purged", "rows", n)
	}
}

// --- helpers ---

type backoff struct{ base, max, cur time.Duration }

func newBackoff(base, max time.Duration) *backoff { return &backoff{base: base, max: max} }

// next returns exponential backoff with full jitter (RS36).
func (b *backoff) next() time.Duration {
	if b.cur == 0 {
		b.cur = b.base
	} else {
		b.cur = min(b.cur*2, b.max)
	}
	return time.Duration(rand.Int64N(int64(b.cur)) + 1)
}

func (b *backoff) reset() { b.cur = 0 }

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
