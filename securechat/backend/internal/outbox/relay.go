// Package outbox publishes committed events with at-least-once delivery.
package outbox

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/metrics"
	"github.com/securechat/backend/internal/store"
	"github.com/twmb/franz-go/pkg/kgo"
)

type Publisher interface {
	ProduceSync(context.Context, ...*kgo.Record) kgo.ProduceResults
}
type Config struct {
	PollInterval      time.Duration
	BatchSize         int
	LockID            int64
	Retention         time.Duration
	PublishTimeout    time.Duration
	HeartbeatInterval time.Duration
}
type Relay struct {
	pool *pgxpool.Pool
	pub  Publisher
	cfg  Config
	log  *slog.Logger
}

func NewRelay(pool *pgxpool.Pool, pub Publisher, cfg Config, log *slog.Logger) *Relay {
	if cfg.PublishTimeout <= 0 {
		cfg.PublishTimeout = 10 * time.Second
	}
	if cfg.HeartbeatInterval <= 0 {
		cfg.HeartbeatInterval = 250 * time.Millisecond
	}
	return &Relay{pool, pub, cfg, log.With("component", "outbox-relay")}
}
func (r *Relay) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := r.leadAndRelay(ctx); err != nil && ctx.Err() == nil {
			r.log.Warn("relay session ended")
		}
		sleep(ctx, r.cfg.PollInterval)
	}
}
func (r *Relay) leadAndRelay(ctx context.Context) error {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// Never return a possibly session-locked connection to the pool.
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = conn.Hijack().Close(closeCtx)
	}()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, r.cfg.LockID).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return nil
	}
	metrics.RelayLeader.Set(1)
	defer metrics.RelayLeader.Set(0)
	r.log.Info("acquired relay leadership")
	backoff := newBackoff(100*time.Millisecond, 10*time.Second)
	lastPurge := time.Now()
	for ctx.Err() == nil {
		rows, err := store.FetchUnpublished(ctx, conn, r.cfg.BatchSize)
		if err != nil {
			return err
		}
		if backlog, err := store.OutboxBacklog(ctx, conn); err == nil {
			metrics.OutboxBacklog.Set(float64(backlog))
		} else {
			return err
		}
		if time.Since(lastPurge) >= time.Minute {
			if _, err := store.PurgePublishedOutbox(ctx, conn, time.Now().Add(-r.cfg.Retention)); err != nil {
				return err
			}
			lastPurge = time.Now()
		}
		if len(rows) == 0 {
			sleep(ctx, r.cfg.PollInterval)
			continue
		}
		failed := false
		// Sending a batch before observing failures can publish past a failed head.
		for _, row := range rows {
			record := &kgo.Record{Topic: row.Topic, Key: []byte(row.Key), Value: row.Payload,
				Headers: []kgo.RecordHeader{{Key: "eventId", Value: []byte(row.EventID)}, {Key: "eventType", Value: []byte(row.EventType)}}}
			if err := r.publishGuarded(ctx, conn, record); err != nil {
				if ctx.Err() != nil || conn.Conn().IsClosed() {
					return err
				}
				metrics.OutboxPublishErrors.Inc()
				// Error categories only: raw broker errors may contain sensitive data.
				if err := store.RecordOutboxFailure(ctx, conn, row.ID, "broker_publish_failed"); err != nil {
					return err
				}
				r.log.Warn("broker publish failed; retrying pending head")
				sleep(ctx, backoff.next())
				failed = true
				break
			}
			// Mark on the lock session. Session loss after broker ACK leaves a replay
			// with the original eventId, never a false published marker.
			now := time.Now().UTC()
			if err := store.MarkPublished(ctx, conn, []int64{row.ID}, now); err != nil {
				return err
			}
			metrics.OutboxPublished.Inc()
			metrics.StageAcceptedToPublished.Observe(max(0, now.Sub(row.CreatedAt).Seconds()))
		}
		if !failed {
			backoff.reset()
		}
	}
	return ctx.Err()
}
func (r *Relay) publishGuarded(ctx context.Context, conn *pgxpool.Conn, record *kgo.Record) error {
	op, cancel := context.WithTimeout(ctx, r.cfg.PublishTimeout)
	defer cancel()
	done := make(chan kgo.ProduceResults, 1)
	go func() { done <- r.pub.ProduceSync(op, record) }()
	ticker := time.NewTicker(r.cfg.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case results := <-done:
			if len(results) != 1 {
				return errors.New("missing broker acknowledgement")
			}
			return results[0].Err
		case <-ticker.C:
			probe, stop := context.WithTimeout(op, r.cfg.HeartbeatInterval)
			err := conn.Ping(probe)
			stop()
			if err != nil {
				cancel()
				<-done
				return err
			}
		case <-op.Done():
			cancel()
			<-done
			return op.Err()
		}
	}
}

type backoff struct{ base, max, cur time.Duration }

func newBackoff(base, max time.Duration) *backoff { return &backoff{base: base, max: max} }
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
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
