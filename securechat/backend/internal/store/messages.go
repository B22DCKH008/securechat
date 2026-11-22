package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/securechat/backend/internal/domain"
)

const messageCols = `id, client_message_id, conversation_id, seq, sender_id, ciphertext, protocol_meta, client_created_at, created_at, kind, system_event`

// viewerCols substitutes the reader's pairwise copy for group messages ($2 = viewer).
const viewerCols = `m.id, m.client_message_id, m.conversation_id, m.seq, m.sender_id,
	COALESCE(r.ciphertext, m.ciphertext), COALESCE(r.protocol_meta, m.protocol_meta),
	m.client_created_at, m.created_at, m.kind, m.system_event`

func scanMessage(row pgx.Row) (domain.Message, error) {
	var m domain.Message
	var system []byte
	err := row.Scan(&m.ID, &m.ClientMessageID, &m.ConversationID, &m.Seq, &m.SenderID,
		&m.Ciphertext, &m.ProtocolMeta, &m.ClientCreatedAt, &m.CreatedAt, &m.Kind, &system)
	if err == nil && len(system) > 0 {
		m.System = new(domain.SystemEvent)
		err = json.Unmarshal(system, m.System)
	}
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
	ciphertext := m.Ciphertext
	if ciphertext == nil {
		ciphertext = []byte{} // group/system rows: NOT NULL, empty
	}
	kind := m.Kind
	if kind == "" {
		kind = domain.MessageKindText
	}
	var system []byte
	if m.System != nil {
		var err error
		if system, err = json.Marshal(m.System); err != nil {
			return false, err
		}
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO messages (id, client_message_id, conversation_id, seq, sender_id,
		                      ciphertext, protocol_meta, client_created_at, created_at, kind, system_event)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (sender_id, client_message_id) DO NOTHING`,
		m.ID, m.ClientMessageID, m.ConversationID, m.Seq, m.SenderID,
		ciphertext, meta, m.ClientCreatedAt, m.CreatedAt, kind, system)
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

// InsertRecipientCiphertexts stores the pairwise copies of a group message.
func InsertRecipientCiphertexts(ctx context.Context, tx pgx.Tx, messageID uuid.UUID, copies []domain.RecipientCiphertext) error {
	ids, devices, cts, metas := splitCopies(copies)
	_, err := tx.Exec(ctx, `
		INSERT INTO message_recipients (message_id, recipient_id, device_id, ciphertext, protocol_meta)
		SELECT $1, c.rid, c.did, c.ct, c.meta::jsonb
		FROM unnest($2::uuid[], $3::int[], $4::bytea[], $5::text[]) AS c(rid, did, ct, meta)`,
		messageID, ids, devices, cts, metas)
	return err
}

func splitCopies(copies []domain.RecipientCiphertext) ([]uuid.UUID, []int32, [][]byte, []string) {
	ids := make([]uuid.UUID, len(copies))
	devices := make([]int32, len(copies))
	cts := make([][]byte, len(copies))
	metas := make([]string, len(copies))
	for i, c := range copies {
		ids[i], devices[i], cts[i] = c.RecipientID, int32(c.DeviceID), c.Ciphertext
		metas[i] = string(c.ProtocolMeta)
		if metas[i] == "" {
			metas[i] = "{}"
		}
	}
	return ids, devices, cts, metas
}

// MessagesAfterFor is MessagesAfter for one reader: group copies are swapped in
// and nothing at or before minSeq (the reader's joined_seq) is returned.
func MessagesAfterFor(ctx context.Context, db DBTX, convID, viewer uuid.UUID, afterSeq, minSeq int64, limit int) ([]domain.Message, error) {
	rows, err := db.Query(ctx, `
		SELECT `+viewerCols+` FROM messages m
		LEFT JOIN message_recipients r ON r.message_id = m.id AND r.recipient_id = $2
		WHERE m.conversation_id = $1 AND m.seq > $3
		ORDER BY m.seq ASC LIMIT $4`, convID, viewer, max(afterSeq, minSeq), limit)
	if err != nil {
		return nil, err
	}
	return collectMessages(rows)
}

// MessagesBeforeFor is MessagesBefore for one reader (see MessagesAfterFor).
func MessagesBeforeFor(ctx context.Context, db DBTX, convID, viewer uuid.UUID, beforeSeq, minSeq int64, limit int) ([]domain.Message, error) {
	if beforeSeq <= 0 {
		beforeSeq = 1<<62 - 1
	}
	rows, err := db.Query(ctx, `
		SELECT `+viewerCols+` FROM messages m
		LEFT JOIN message_recipients r ON r.message_id = m.id AND r.recipient_id = $2
		WHERE m.conversation_id = $1 AND m.seq < $3 AND m.seq > $4
		ORDER BY m.seq DESC LIMIT $5`, convID, viewer, beforeSeq, minSeq, limit)
	if err != nil {
		return nil, err
	}
	return collectMessages(rows)
}

// MatchesRecipientCopies reports whether a group message stored exactly these
// copies (JSONB equality for metadata, like MatchesRetry).
func MatchesRecipientCopies(ctx context.Context, db DBTX, id uuid.UUID, copies []domain.RecipientCiphertext) (bool, error) {
	ids, devices, cts, metas := splitCopies(copies)
	var stored, matched int
	err := db.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM message_recipients WHERE message_id = $1),
		       (SELECT count(*) FROM message_recipients r
		        JOIN unnest($2::uuid[], $3::int[], $4::bytea[], $5::text[]) AS c(rid, did, ct, meta)
		          ON r.recipient_id = c.rid AND r.device_id = c.did AND r.ciphertext = c.ct
		         AND r.protocol_meta = c.meta::jsonb
		        WHERE r.message_id = $1)`, id, ids, devices, cts, metas).Scan(&stored, &matched)
	return err == nil && stored == len(copies) && matched == len(copies), err
}

// MatchesRetry uses PostgreSQL JSONB equality, so key order, whitespace and
// numeric exponent formatting cannot turn an identical retry into a conflict.
func MatchesRetry(ctx context.Context, db DBTX, id uuid.UUID, cmd domain.SendCommand) (bool, error) {
	var match bool
	err := db.QueryRow(ctx, `SELECT ciphertext=$2 AND protocol_meta=$3::jsonb
		AND client_created_at IS NOT DISTINCT FROM $4::timestamptz
		FROM messages WHERE id=$1`, id, cmd.Ciphertext, cmd.ProtocolMeta, cmd.ClientCreatedAt).Scan(&match)
	return match, err
}
