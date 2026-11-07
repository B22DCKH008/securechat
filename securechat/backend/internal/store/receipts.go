package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/domain"
)

// UpsertReceipt records delivered/read idempotently. Returns changed=false when the
// state was already recorded, so repeated ACKs do not emit duplicate events.
// read implies delivered.
func UpsertReceipt(ctx context.Context, db DBTX, msgID, userID uuid.UUID, state domain.DeliveryState, at time.Time) (bool, error) {
	var q string
	switch state {
	case domain.StateDelivered:
		q = `INSERT INTO message_receipts (message_id, user_id, delivered_at) VALUES ($1,$2,$3)
		     ON CONFLICT (message_id, user_id) DO UPDATE SET delivered_at = EXCLUDED.delivered_at
		     WHERE message_receipts.delivered_at IS NULL`
	case domain.StateRead:
		q = `INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at) VALUES ($1,$2,$3,$3)
		     ON CONFLICT (message_id, user_id) DO UPDATE
		       SET read_at = EXCLUDED.read_at,
		           delivered_at = COALESCE(message_receipts.delivered_at, EXCLUDED.delivered_at)
		     WHERE message_receipts.read_at IS NULL`
	default:
		return false, domain.ErrInvalidInput
	}
	tag, err := db.Exec(ctx, q, msgID, userID, at)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
