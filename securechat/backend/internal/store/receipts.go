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

func AppendReceiptChange(ctx context.Context, db DBTX, msg domain.Message, recipient uuid.UUID, state domain.DeliveryState, at time.Time) (int64, error) {
	var revision int64
	err := db.QueryRow(ctx, `UPDATE conversations SET last_receipt_seq=last_receipt_seq+1 WHERE id=$1 RETURNING last_receipt_seq`, msg.ConversationID).Scan(&revision)
	if err != nil {
		return 0, err
	}
	_, err = db.Exec(ctx, `INSERT INTO receipt_changes (conversation_id,receipt_seq,message_id,message_seq,recipient_id,sender_id,state,occurred_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, msg.ConversationID, revision, msg.ID, msg.Seq, recipient, msg.SenderID, state, at)
	return revision, err
}

func ReceiptChangesAfter(ctx context.Context, db DBTX, conv uuid.UUID, after int64, limit int) ([]domain.Receipt, error) {
	rows, err := db.Query(ctx, `SELECT receipt_seq,message_id,conversation_id,message_seq,recipient_id,sender_id,state,occurred_at
		FROM receipt_changes WHERE conversation_id=$1 AND receipt_seq>$2 ORDER BY receipt_seq LIMIT $3`, conv, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Receipt, 0)
	for rows.Next() {
		var r domain.Receipt
		if err := rows.Scan(&r.ReceiptSeq, &r.MessageID, &r.ConversationID, &r.Seq, &r.RecipientID, &r.SenderID, &r.State, &r.At); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
