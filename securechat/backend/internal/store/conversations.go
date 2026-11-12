package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/securechat/backend/internal/domain"
)

func directKey(a, b uuid.UUID) string {
	if a.String() > b.String() {
		a, b = b, a
	}
	return a.String() + ":" + b.String()
}

// GetOrCreateDirect returns the unique 1:1 conversation between a and b.
func GetOrCreateDirect(ctx context.Context, tx pgx.Tx, a, b uuid.UUID) (domain.Conversation, error) {
	key := directKey(a, b)
	var c domain.Conversation
	err := tx.QueryRow(ctx, `
		INSERT INTO conversations (kind, direct_key) VALUES ('direct', $1)
		ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key
		RETURNING id, kind, last_seq, created_at`, key).
		Scan(&c.ID, &c.Kind, &c.LastSeq, &c.CreatedAt)
	if err != nil {
		return c, fmt.Errorf("upsert conversation: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id)
		VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`, c.ID, a, b); err != nil {
		return c, fmt.Errorf("insert members: %w", err)
	}
	c.Members = []uuid.UUID{a, b}
	return c, nil
}

func ListConversations(ctx context.Context, db DBTX, userID uuid.UUID) ([]domain.Conversation, error) {
	rows, err := db.Query(ctx, `
		SELECT c.id, c.kind, c.last_seq, c.created_at,
		       ARRAY(SELECT m2.user_id FROM conversation_members m2 WHERE m2.conversation_id = c.id)
		FROM conversations c
		JOIN conversation_members m ON m.conversation_id = c.id
		WHERE m.user_id = $1
		ORDER BY c.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Conversation
	for rows.Next() {
		var c domain.Conversation
		if err := rows.Scan(&c.ID, &c.Kind, &c.LastSeq, &c.CreatedAt, &c.Members); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Members returns member ids; ErrNotFound if the conversation does not exist.
func Members(ctx context.Context, db DBTX, convID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := db.Query(ctx, `SELECT user_id FROM conversation_members WHERE conversation_id = $1`, convID)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, domain.ErrNotFound
	}
	return ids, nil
}

// IsMember is the authorization check for every conversation access (SC5).
func IsMember(ctx context.Context, db DBTX, convID, userID uuid.UUID) (bool, error) {
	var ok bool
	err := db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)`,
		convID, userID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return ok, err
}

// LockMember prevents deletion of the membership during a protected write.
func LockMember(ctx context.Context, tx pgx.Tx, convID, userID uuid.UUID) error {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 FOR SHARE`, convID, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotMember
	}
	return err
}
