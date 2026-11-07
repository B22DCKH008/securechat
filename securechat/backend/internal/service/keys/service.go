// Package keys serves Signal Protocol PUBLIC pre-key bundles (SC1, SC2).
// The server never generates, sees or stores private keys; it is a directory only.
package keys

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/platform/postgres"
	"github.com/securechat/backend/internal/store"
)

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

type UploadRequest struct {
	DeviceID              int                    `json:"deviceId"`
	RegistrationID        int                    `json:"registrationId"`
	IdentityKey           []byte                 `json:"identityKey"`
	SignedPreKeyID        int                    `json:"signedPreKeyId"`
	SignedPreKey          []byte                 `json:"signedPreKey"`
	SignedPreKeySignature []byte                 `json:"signedPreKeySignature"`
	OneTimePreKeys        []domain.OneTimePreKey `json:"oneTimePreKeys"`
}

func (s *Service) Upload(ctx context.Context, userID uuid.UUID, req UploadRequest) error {
	if req.DeviceID <= 0 || len(req.IdentityKey) == 0 || len(req.SignedPreKey) == 0 || len(req.SignedPreKeySignature) == 0 {
		return domain.ErrInvalidInput
	}
	// NOTE: signature verification of the signed pre-key is done by the CLIENT
	// library when building a session; the server stores bytes as-is.
	// TODO(BE2/FE1, SC2): detect identity_key change and notify peers ("safety number changed").
	return postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := store.UpsertPreKeyBundle(ctx, tx, domain.PreKeyBundle{
			UserID: userID, DeviceID: req.DeviceID, RegistrationID: req.RegistrationID,
			IdentityKey: req.IdentityKey, SignedPreKeyID: req.SignedPreKeyID,
			SignedPreKey: req.SignedPreKey, SignedPreKeySignature: req.SignedPreKeySignature,
		}); err != nil {
			return err
		}
		return store.AddOneTimePreKeys(ctx, tx, userID, req.DeviceID, req.OneTimePreKeys)
	})
}

// Claim returns a peer's bundle and consumes one one-time pre-key.
func (s *Service) Claim(ctx context.Context, peerID uuid.UUID, deviceID int) (domain.PreKeyBundle, error) {
	var b domain.PreKeyBundle
	err := postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		b, err = store.ClaimPreKeyBundle(ctx, tx, peerID, deviceID)
		return err
	})
	return b, err
}

// TODO(BE2, SC4): list devices of a user for multi-device fan-out.
// TODO(BE2): endpoint reporting remaining one-time pre-key count so clients can replenish.
