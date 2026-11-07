package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/domain"
)

// UpsertUser returns the user with this username, creating it if needed.
// Used by the DEV login only; replace with real registration/auth (TODO BE1).
func UpsertUser(ctx context.Context, db DBTX, username string) (domain.User, error) {
	var u domain.User
	err := db.QueryRow(ctx, `
		INSERT INTO users (username) VALUES ($1)
		ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
		RETURNING id, username, created_at`, username).
		Scan(&u.ID, &u.Username, &u.CreatedAt)
	return u, err
}

func UserExists(ctx context.Context, db DBTX, id uuid.UUID) (bool, error) {
	var ok bool
	err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, id).Scan(&ok)
	return ok, err
}
