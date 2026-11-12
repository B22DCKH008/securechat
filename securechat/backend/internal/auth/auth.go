// Package auth issues/verifies JWT access tokens and provides HTTP middleware (RS11, SC5).
//
// Session-backed tokens are checked against PostgreSQL by Service on REST and WS.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var ErrUnauthorized = errors.New("unauthorized")

type Issuer struct {
	secret []byte
	ttl    time.Duration
}

type Claims struct {
	DeviceID int `json:"deviceId,omitempty"`
	jwt.RegisteredClaims
}

func NewIssuer(secret string, ttl time.Duration) *Issuer {
	return &Issuer{secret: []byte(secret), ttl: ttl}
}

func (i *Issuer) Issue(userID uuid.UUID) (string, time.Time, error) {
	return i.issue(userID, uuid.Nil, 0)
}

func (i *Issuer) issue(userID, sessionID uuid.UUID, deviceID int) (string, time.Time, error) {
	exp := time.Now().Add(i.ttl)
	claims := Claims{DeviceID: deviceID, RegisteredClaims: jwt.RegisteredClaims{
		Subject:   userID.String(),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(exp),
		Issuer:    "securechat",
		Audience:  jwt.ClaimStrings{"securechat-api"},
	}}
	if sessionID != uuid.Nil {
		claims.ID = sessionID.String()
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString(i.secret)
	return s, exp, err
}

func (i *Issuer) Verify(token string) (uuid.UUID, error) {
	claims, err := i.parse(token)
	if err != nil {
		return uuid.Nil, err
	}
	return uuid.Parse(claims.Subject)
}

func (i *Issuer) parse(token string) (Claims, error) {
	var claims Claims
	if len(token) > 4096 {
		return claims, ErrUnauthorized
	}
	_, err := jwt.ParseWithClaims(token, &claims, func(*jwt.Token) (any, error) { return i.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer("securechat"),
		jwt.WithAudience("securechat-api"),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
	)
	if err != nil {
		return claims, ErrUnauthorized
	}
	id, err := uuid.Parse(claims.Subject)
	if err != nil || id == uuid.Nil || claims.IssuedAt == nil {
		return claims, ErrUnauthorized
	}
	return claims, nil
}

type ctxKey struct{}

// UserID returns the authenticated user. senderId is ALWAYS taken from here,
// never from the request body (doc §7.1).
func UserID(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(ctxKey{}).(uuid.UUID)
	return id, ok
}

func WithUserID(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// Middleware requires "Authorization: Bearer <jwt>".
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Fields(r.Header.Get("Authorization"))
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			unauthorized(w)
			return
		}
		principal, err := s.Verify(r.Context(), parts[1])
		if err != nil {
			if errors.Is(err, ErrUnauthorized) {
				unauthorized(w)
			} else {
				w.Header().Set("Content-Type", "application/json")
				http.Error(w, `{"error":"auth_unavailable"}`, http.StatusServiceUnavailable)
			}
			return
		}
		ctx := context.WithValue(WithUserID(r.Context(), principal.UserID), principalKey{}, principal)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	w.Header().Set("Content-Type", "application/json")
	http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
}
