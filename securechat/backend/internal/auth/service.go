package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

var ErrConflict = errors.New("username already exists")
var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)

const refreshLifetime = 30 * 24 * time.Hour

type Principal struct {
	UserID    uuid.UUID
	DeviceID  int
	SessionID uuid.UUID
}
type principalKey struct{}

func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	DeviceID int    `json:"deviceId,omitempty"`
}
type Tokens struct {
	UserID       uuid.UUID `json:"userId"`
	DeviceID     int       `json:"deviceId"`
	AccessToken  string    `json:"accessToken"`
	RefreshToken string    `json:"refreshToken"`
	ExpiresAt    time.Time `json:"expiresAt"`
}
type Service struct {
	pool          *pgxpool.Pool
	issuer        *Issuer
	allowDev      bool
	dummyHash     []byte
	passwordSlots chan struct{}
}

func NewService(pool *pgxpool.Pool, issuer *Issuer, allowDev bool) (*Service, error) {
	if pool == nil || issuer == nil {
		return nil, errors.New("auth requires database and issuer")
	}
	dummy, err := hashPassword("securechat-dummy-password")
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, issuer: issuer, allowDev: allowDev, dummyHash: dummy, passwordSlots: make(chan struct{}, 2)}, nil
}

// Issue is used exclusively by the explicitly enabled dev-login endpoint.
func (s *Service) Issue(userID uuid.UUID) (string, time.Time, error) {
	if !s.allowDev {
		return "", time.Time{}, ErrUnauthorized
	}
	return s.issuer.Issue(userID)
}

func (s *Service) Verify(ctx context.Context, token string) (Principal, error) {
	c, err := s.issuer.parse(token)
	if err != nil {
		return Principal{}, ErrUnauthorized
	}
	p := Principal{UserID: uuid.MustParse(c.Subject), DeviceID: c.DeviceID}
	if c.ID == "" {
		if s.allowDev && c.DeviceID == 0 {
			return p, nil
		}
		return Principal{}, ErrUnauthorized
	}
	p.SessionID, err = uuid.Parse(c.ID)
	if err != nil || p.SessionID == uuid.Nil || p.DeviceID < 1 {
		return Principal{}, ErrUnauthorized
	}
	var active bool
	err = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM auth_sessions
		WHERE id=$1 AND user_id=$2 AND device_id=$3 AND revoked_at IS NULL AND expires_at > now())`,
		p.SessionID, p.UserID, p.DeviceID).Scan(&active)
	if err != nil {
		return Principal{}, err
	}
	if !active {
		return Principal{}, ErrUnauthorized
	}
	return p, nil
}

func validPassword(password string) bool { return len(password) >= 12 && len(password) <= 1024 }
func preparedPassword(password string) []byte {
	h := sha256.Sum256([]byte(password))
	return []byte("securechat-password-v1:" + base64.RawStdEncoding.EncodeToString(h[:]))
}
func hashPassword(password string) ([]byte, error) {
	return bcrypt.GenerateFromPassword(preparedPassword(password), 12)
}

func (s *Service) passwordWork(ctx context.Context, work func() error) error {
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
		if err := ctx.Err(); err != nil {
			return err
		}
		return work()
	default:
		return domain.ErrRateLimited
	}
}

func (s *Service) Register(ctx context.Context, input Credentials) (Tokens, error) {
	if input.DeviceID == 0 {
		input.DeviceID = 1
	}
	if !usernamePattern.MatchString(input.Username) || !validPassword(input.Password) || input.DeviceID < 1 || input.DeviceID > 2147483647 {
		return Tokens{}, domain.ErrInvalidInput
	}
	var hash []byte
	err := s.passwordWork(ctx, func() error { var err error; hash, err = hashPassword(input.Password); return err })
	if err != nil {
		return Tokens{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tokens{}, err
	}
	defer tx.Rollback(context.Background())
	uid := uuid.New()
	if _, err = tx.Exec(ctx, `INSERT INTO users (id,username,password_hash) VALUES ($1,$2,$3)`, uid, input.Username, string(hash)); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Tokens{}, ErrConflict
		}
		return Tokens{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO devices (user_id,device_id) VALUES ($1,$2)`, uid, input.DeviceID); err != nil {
		return Tokens{}, err
	}
	tokens, err := s.createSession(ctx, tx, uid, input.DeviceID, uuid.Nil)
	if err != nil {
		return Tokens{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Tokens{}, err
	}
	return tokens, nil
}

func (s *Service) Login(ctx context.Context, input Credentials) (Tokens, error) {
	if input.DeviceID == 0 {
		input.DeviceID = 1
	}
	if !usernamePattern.MatchString(input.Username) || !validPassword(input.Password) || input.DeviceID < 1 {
		return Tokens{}, ErrUnauthorized
	}
	var uid uuid.UUID
	var hash *string
	err := s.pool.QueryRow(ctx, `SELECT id,password_hash FROM users WHERE username=$1`, input.Username).Scan(&uid, &hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Tokens{}, err
	}
	stored := s.dummyHash
	if hash != nil {
		stored = []byte(*hash)
	}
	err = s.passwordWork(ctx, func() error { return bcrypt.CompareHashAndPassword(stored, preparedPassword(input.Password)) })
	if errors.Is(err, domain.ErrRateLimited) {
		return Tokens{}, err
	}
	if err != nil || hash == nil || uid == uuid.Nil {
		return Tokens{}, ErrUnauthorized
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tokens{}, err
	}
	defer tx.Rollback(context.Background())
	var device int
	if err = tx.QueryRow(ctx, `SELECT device_id FROM devices WHERE user_id=$1 AND device_id=$2 FOR SHARE`, uid, input.DeviceID).Scan(&device); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Tokens{}, ErrUnauthorized
		}
		return Tokens{}, err
	}
	tokens, err := s.createSession(ctx, tx, uid, device, uuid.Nil)
	if err != nil {
		return Tokens{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Tokens{}, err
	}
	return tokens, nil
}

func (s *Service) createSession(ctx context.Context, tx pgx.Tx, uid uuid.UUID, device int, family uuid.UUID) (Tokens, error) {
	sid := uuid.New()
	if family == uuid.Nil {
		family = sid
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return Tokens{}, err
	}
	refresh := base64.RawURLEncoding.EncodeToString(raw[:])
	hash := sha256.Sum256([]byte(refresh))
	if _, err := tx.Exec(ctx, `INSERT INTO auth_sessions (id,user_id,device_id,family_id,refresh_token_hash,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)`, sid, uid, device, family, hash[:], time.Now().Add(refreshLifetime)); err != nil {
		return Tokens{}, err
	}
	access, expiry, err := s.issuer.issue(uid, sid, device)
	return Tokens{UserID: uid, DeviceID: device, AccessToken: access, RefreshToken: refresh, ExpiresAt: expiry}, err
}

func lockFamily(ctx context.Context, tx pgx.Tx, family uuid.UUID) error {
	hash := sha256.Sum256(family[:])
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1::bigint)`, int64(binary.BigEndian.Uint64(hash[:8])))
	return err
}
func revokeFamily(ctx context.Context, tx pgx.Tx, family uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1`, family)
	return err
}

// Refresh rotates once; replay revokes the whole family, including the winner of
// a concurrent refresh. This follows the source project's locking policy.
func (s *Service) Refresh(ctx context.Context, refresh string) (Tokens, error) {
	if len(refresh) != 43 {
		return Tokens{}, ErrUnauthorized
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(refresh)
	if err != nil || len(raw) != 32 {
		return Tokens{}, ErrUnauthorized
	}
	hash := sha256.Sum256([]byte(refresh))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tokens{}, err
	}
	defer tx.Rollback(context.Background())
	var family uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT family_id FROM auth_sessions WHERE refresh_token_hash=$1`, hash[:]).Scan(&family); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Tokens{}, ErrUnauthorized
		}
		return Tokens{}, err
	}
	if err = lockFamily(ctx, tx, family); err != nil {
		return Tokens{}, err
	}
	var sid, uid uuid.UUID
	var device int
	var revoked, active bool
	err = tx.QueryRow(ctx, `SELECT id,user_id,device_id,revoked_at IS NOT NULL,expires_at > now()
		FROM auth_sessions WHERE refresh_token_hash=$1 FOR UPDATE`, hash[:]).Scan(&sid, &uid, &device, &revoked, &active)
	if err != nil {
		return Tokens{}, err
	}
	if revoked {
		if err = revokeFamily(ctx, tx, family); err != nil {
			return Tokens{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return Tokens{}, err
		}
		return Tokens{}, ErrUnauthorized
	}
	if !active {
		return Tokens{}, ErrUnauthorized
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, sid); err != nil {
		return Tokens{}, err
	}
	tokens, err := s.createSession(ctx, tx, uid, device, family)
	if err != nil {
		return Tokens{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Tokens{}, err
	}
	return tokens, nil
}

func (s *Service) Logout(ctx context.Context, p Principal) error {
	if p.SessionID == uuid.Nil {
		return ErrUnauthorized
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var family uuid.UUID
	err = tx.QueryRow(ctx, `SELECT family_id FROM auth_sessions WHERE id=$1 AND user_id=$2 AND device_id=$3`, p.SessionID, p.UserID, p.DeviceID).Scan(&family)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if err = lockFamily(ctx, tx, family); err != nil {
		return err
	}
	if err = revokeFamily(ctx, tx, family); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
