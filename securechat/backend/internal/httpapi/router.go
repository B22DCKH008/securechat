// Package httpapi exposes the REST API (contract: api/openapi.yaml) and mounts the
// WebSocket gateway and metrics endpoint.
package httpapi

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/metrics"
	"github.com/securechat/backend/internal/service/keys"
	"github.com/securechat/backend/internal/service/messaging"
)

type Limiter interface {
	Allow(ctx context.Context, scope, subject string) bool
}

type Deps struct {
	Messaging  *messaging.Service
	Keys       *keys.Service
	Auth       *auth.Issuer
	Limiter    Limiter
	WS         http.Handler
	DevLogin   func(ctx context.Context, username string) (uuid.UUID, error) // nil = disabled
	Ready      func(ctx context.Context) error
	Log        *slog.Logger
	InstanceID string
}

type api struct{ Deps }

func NewRouter(d Deps) http.Handler {
	a := &api{d}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "instance": d.InstanceID})
	})
	mux.HandleFunc("GET /readyz", a.readyz)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.Handle("GET /ws", d.WS)

	if d.DevLogin != nil {
		mux.HandleFunc("POST /v1/auth/dev-login", a.devLogin)
	}

	authed := func(h http.HandlerFunc) http.Handler { return d.Auth.Middleware(a.rateLimit(h)) }
	mux.Handle("GET /v1/conversations", authed(a.listConversations))
	mux.Handle("POST /v1/conversations", authed(a.createConversation))
	mux.Handle("GET /v1/conversations/{id}/messages", authed(a.history))
	mux.Handle("POST /v1/conversations/{id}/messages", authed(a.sendMessage))
	mux.Handle("POST /v1/messages/{id}/receipts", authed(a.receipt))
	mux.Handle("POST /v1/sync", authed(a.sync))
	mux.Handle("PUT /v1/keys/bundle", authed(a.uploadKeys))
	mux.Handle("GET /v1/users/{id}/devices/{deviceId}/bundle", authed(a.claimBundle))

	return requestLogger(d.Log, mux)
}

func (a *api) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.Ready(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody{"not_ready"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (a *api) rateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, _ := auth.UserID(r.Context())
		if !a.Limiter.Allow(r.Context(), "http", uid.String()) {
			metrics.RateLimited.WithLabelValues("http").Inc()
			writeError(w, a.Log, domain.ErrRateLimited)
			return
		}
		next(w, r)
	}
}

// requestLogger logs method + PATH ONLY. Never the query string (contains WS token)
// nor bodies (contain ciphertext) – INF3/SC7.
func requestLogger(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if r.URL.Path == "/metrics" || r.URL.Path == "/healthz" {
			return
		}
		log.Info("http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "dur_ms", time.Since(start).Milliseconds())
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Hijack is required for the WebSocket upgrade on /ws.
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying ResponseWriter does not support hijacking")
	}
	s.status = http.StatusSwitchingProtocols
	return hj.Hijack()
}
