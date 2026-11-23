package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/securechat/backend/internal/domain"
)

// Group membership repositories (RS34). Lock order used by every writer:
// member rows (sorted by user_id) → conversation row. Send and Acknowledge
// lock the caller's member row and then the conversation row, so they agree.

// CreateGroup inserts a group conversation, its owner and members (joined_seq 0).
func CreateGroup(ctx context.Context, tx pgx.Tx, owner uuid.UUID, title string, members []uuid.UUID) (domain.Conversation, error) {
	c := domain.Conversation{Kind: domain.KindGroup, Title: &title, CreatedBy: &owner}
	err := tx.QueryRow(ctx, `INSERT INTO conversations (kind, title, created_by) VALUES ('group', $1, $2)
		RETURNING id, last_seq, created_at`, title, owner).Scan(&c.ID, &c.LastSeq, &c.CreatedAt)
	if err != nil {
		return c, fmt.Errorf("insert group: %w", err)
	}
	all := append([]uuid.UUID{owner}, members...)
	if _, err = tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, role)
		SELECT $1, u, CASE WHEN u = $2 THEN 'owner' ELSE 'member' END FROM unnest($3::uuid[]) AS u`,
		c.ID, owner, all); err != nil {
		return c, fmt.Errorf("insert group members: %w", err)
	}
	c.Members = all
	return c, nil
}

// NextSeqForKind allocates a seq like NextSeq and also returns the kind.
func NextSeqForKind(ctx context.Context, tx pgx.Tx, convID uuid.UUID) (int64, string, error) {
	var seq int64
	var kind string
	err := tx.QueryRow(ctx,
		`UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq, kind`, convID).Scan(&seq, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", domain.ErrNotFound
	}
	return seq, kind, err
}

// Membership returns the caller's role and joined_seq, or ErrNotMember.
func Membership(ctx context.Context, db DBTX, convID, userID uuid.UUID) (domain.Member, error) {
	m := domain.Member{UserID: userID}
	err := db.QueryRow(ctx, `SELECT role, joined_seq, joined_at FROM conversation_members
		WHERE conversation_id = $1 AND user_id = $2`, convID, userID).Scan(&m.Role, &m.JoinedSeq, &m.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, domain.ErrNotMember
	}
	return m, err
}

// LockMembers locks the given member rows (all rows when userIDs is nil)
// FOR UPDATE in user_id order and returns those that exist.
func LockMembers(ctx context.Context, tx pgx.Tx, convID uuid.UUID, userIDs []uuid.UUID) (map[uuid.UUID]domain.Member, error) {
	rows, err := tx.Query(ctx, `SELECT user_id, role, joined_seq, joined_at FROM conversation_members
		WHERE conversation_id = $1 AND ($2::uuid[] IS NULL OR user_id = ANY($2)) ORDER BY user_id FOR UPDATE`, convID, userIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[uuid.UUID]domain.Member, len(userIDs))
	for rows.Next() {
		var m domain.Member
		if err := rows.Scan(&m.UserID, &m.Role, &m.JoinedSeq, &m.JoinedAt); err != nil {
			return nil, err
		}
		out[m.UserID] = m
	}
	return out, rows.Err()
}

// LockMemberShare is LockMember that also returns role and joined_seq.
func LockMemberShare(ctx context.Context, tx pgx.Tx, convID, userID uuid.UUID) (domain.Member, error) {
	m := domain.Member{UserID: userID}
	err := tx.QueryRow(ctx, `SELECT role, joined_seq, joined_at FROM conversation_members
		WHERE conversation_id = $1 AND user_id = $2 FOR SHARE`, convID, userID).Scan(&m.Role, &m.JoinedSeq, &m.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, domain.ErrNotMember
	}
	return m, err
}

// ListMembers returns members ordered by join time.
func ListMembers(ctx context.Context, db DBTX, convID uuid.UUID) ([]domain.Member, error) {
	rows, err := db.Query(ctx, `SELECT user_id, role, joined_seq, joined_at FROM conversation_members
		WHERE conversation_id = $1 ORDER BY joined_at, user_id`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Member, 0, 8)
	for rows.Next() {
		var m domain.Member
		if err := rows.Scan(&m.UserID, &m.Role, &m.JoinedSeq, &m.JoinedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddMembers inserts new members visible from joinedSeq and clears departures.
func AddMembers(ctx context.Context, tx pgx.Tx, convID uuid.UUID, userIDs []uuid.UUID, joinedSeq int64) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, role, joined_seq)
		SELECT $1, u, 'member', $3 FROM unnest($2::uuid[]) AS u`, convID, userIDs, joinedSeq); err != nil {
		return fmt.Errorf("insert members: %w", err)
	}
	_, err := tx.Exec(ctx, `DELETE FROM conversation_departures WHERE conversation_id = $1 AND user_id = ANY($2)`, convID, userIDs)
	return err
}

// RemoveMember deletes the membership and records the departure.
func RemoveMember(ctx context.Context, tx pgx.Tx, convID, userID uuid.UUID, leftSeq int64) error {
	if _, err := tx.Exec(ctx, `DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, convID, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO conversation_departures (conversation_id, user_id, left_seq) VALUES ($1, $2, $3)
		ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_seq = EXCLUDED.left_seq, left_at = now()`,
		convID, userID, leftSeq)
	return err
}

// PromoteOldestMember makes the earliest remaining member the owner.
// Returns uuid.Nil when the group is empty.
func PromoteOldestMember(ctx context.Context, tx pgx.Tx, convID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		UPDATE conversation_members SET role = 'owner'
		WHERE conversation_id = $1 AND user_id = (
			SELECT user_id FROM conversation_members WHERE conversation_id = $1
			ORDER BY joined_at, user_id LIMIT 1)
		RETURNING user_id`, convID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}

func SetTitle(ctx context.Context, tx pgx.Tx, convID uuid.UUID, title string) error {
	_, err := tx.Exec(ctx, `UPDATE conversations SET title = $2 WHERE id = $1`, convID, title)
	return err
}

// CountUsers returns how many of ids exist.
func CountUsers(ctx context.Context, db DBTX, ids []uuid.UUID) (int, error) {
	var n int
	err := db.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = ANY($1)`, ids).Scan(&n)
	return n, err
}

// Departures returns departures of userID among convIDs.
func Departures(ctx context.Context, db DBTX, userID uuid.UUID, convIDs []uuid.UUID) ([]domain.Departure, error) {
	rows, err := db.Query(ctx, `SELECT conversation_id, left_seq, left_at FROM conversation_departures
		WHERE user_id = $1 AND conversation_id = ANY($2) ORDER BY conversation_id`, userID, convIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Departure, 0)
	for rows.Next() {
		var d domain.Departure
		if err := rows.Scan(&d.ConversationID, &d.LeftSeq, &d.LeftAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
