package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/securechat/backend/internal/domain"
)

const messageCols = `id, client_message_id, conversation_id, seq, sender_id, ciphertext, protocol_meta, client_created_at, created_at`

func scanMessage(row pgx.Row) (domain.Message, error) {
	var m domain.Message
	err := row.Scan(&m.ID, &m.ClientMessageID, &m.ConversationID, &m.Seq, &m.SenderID,
		&m.Ciphertext, &m.ProtocolMeta, &m.ClientCreatedAt, &m.CreatedAt)
	return m, err
}

func collectMessages(rows pgx.Rows) ([]domain.Message, error) {
	defer rows.Close()
	out := make([]domain.Message, 0, 32)
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// FindByClientID looks up an already-accepted message for idempotent retries (RS2).
func FindByClientID(ctx context.Context, db DBTX, senderID uuid.UUID, clientMsgID string) (domain.Message, error) {
	m, err := scanMessage(db.QueryRow(ctx,
		`SELECT `+messageCols+` FROM messages WHERE sender_id = $1 AND client_message_id = $2`,
		senderID, clientMsgID))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, domain.ErrNotFound
	}
	return m, err
}

func GetMessage(ctx context.Context, db DBTX, id uuid.UUID) (domain.Message, error) {
	m, err := scanMessage(db.QueryRow(ctx, `SELECT `+messageCols+` FROM messages WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, domain.ErrNotFound
	}
	return m, err
}

// NextSeq allocates the next per-conversation sequence number. The row lock is held
// until the surrounding tx ends, so seq allocation is serialised per conversation (RS5, RS27).
// A rolled-back tx also rolls back the increment, so committed seqs have no gaps.
func NextSeq(ctx context.Context, tx pgx.Tx, convID uuid.UUID) (int64, error) {
	var seq int64
	err := tx.QueryRow(ctx,
		`UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`, convID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, domain.ErrNotFound
	}
	return seq, err
}

// InsertMessage inserts m. Returns inserted=false if (sender_id, client_message_id)
// already exists, i.e. a concurrent retry won the race.
func InsertMessage(ctx context.Context, tx pgx.Tx, m domain.Message) (bool, error) {
	meta := m.ProtocolMeta
	if len(meta) == 0 {
		meta = []byte("{}")
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO messages (id, client_message_id, conversation_id, seq, sender_id,
		                      ciphertext, protocol_meta, client_created_at, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (sender_id, client_message_id) DO NOTHING`,
		m.ID, m.ClientMessageID, m.ConversationID, m.Seq, m.SenderID,
		m.Ciphertext, meta, m.ClientCreatedAt, m.CreatedAt)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// MessagesAfter is the cursor-based sync query (RS4): seq > afterSeq ascending.
func MessagesAfter(ctx context.Context, db DBTX, convID uuid.UUID, afterSeq int64, limit int) ([]domain.Message, error) {
	rows, err := db.Query(ctx, `
		SELECT `+messageCols+` FROM messages
		WHERE conversation_id = $1 AND seq > $2
		ORDER BY seq ASC LIMIT $3`, convID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	return collectMessages(rows)
}

// MessagesBefore is the history pagination query (RS8, RS26): keyset, not OFFSET.
// beforeSeq <= 0 means "latest".
func MessagesBefore(ctx context.Context, db DBTX, convID uuid.UUID, beforeSeq int64, limit int) ([]domain.Message, error) {
	if beforeSeq <= 0 {
		beforeSeq = 1<<62 - 1
	}
	rows, err := db.Query(ctx, `
		SELECT `+messageCols+` FROM messages
		WHERE conversation_id = $1 AND seq < $2
		ORDER BY seq DESC LIMIT $3`, convID, beforeSeq, limit)
	if err != nil {
		return nil, err
	}
	return collectMessages(rows)
}

// TODO(BE1, RS26/EXP6): add MessagesByOffset for the offset-vs-cursor benchmark only.
