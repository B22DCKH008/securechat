package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/securechat/backend/internal/events"
)

type OutboxRow struct {
	ID        int64
	EventID   string
	EventType string
	Topic     string
	Key       string
	Payload   []byte // full JSON envelope
	CreatedAt time.Time
}

// InsertOutbox MUST be called inside the same tx as the business write (KF1).
func InsertOutbox(ctx context.Context, db DBTX, topic, key string, env events.Envelope) error {
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `
		INSERT INTO outbox (event_id, event_type, topic, key, payload, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		env.EventID, string(env.EventType), topic, key, raw, env.OccurredAt)
	return err
}

// FetchUnpublished returns the oldest unpublished rows in id order (KF2).
func FetchUnpublished(ctx context.Context, db DBTX, limit int) ([]OutboxRow, error) {
	rows, err := db.Query(ctx, `
		SELECT id, event_id::text, event_type, topic, key, payload::text, created_at
		FROM outbox WHERE published_at IS NULL
		ORDER BY id ASC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxRow
	for rows.Next() {
		var r OutboxRow
		var payload string
		if err := rows.Scan(&r.ID, &r.EventID, &r.EventType, &r.Topic, &r.Key, &payload, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Payload = []byte(payload)
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkPublished is called only AFTER the broker acked (doc §7.3).
// A crash between ack and this call causes a re-publish → consumers dedupe (KF5).
func MarkPublished(ctx context.Context, db DBTX, ids []int64, at time.Time) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := db.Exec(ctx, `UPDATE outbox SET published_at = $2 WHERE id = ANY($1)`, ids, at)
	return err
}

func RecordOutboxFailure(ctx context.Context, db DBTX, id int64, errMsg string) error {
	_, err := db.Exec(ctx, `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, id, errMsg)
	return err
}

// OutboxBacklog feeds the outbox_backlog gauge (INF4, EXP12).
func OutboxBacklog(ctx context.Context, db DBTX) (int64, error) {
	var n int64
	err := db.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE published_at IS NULL`).Scan(&n)
	return n, err
}

// PurgePublishedOutbox deletes published rows older than retention (KF15).
func PurgePublishedOutbox(ctx context.Context, db DBTX, olderThan time.Time) (int64, error) {
	tag, err := db.Exec(ctx, `DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < $1`, olderThan)
	return tag.RowsAffected(), err
}
