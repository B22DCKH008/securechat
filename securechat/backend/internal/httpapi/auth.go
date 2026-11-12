package httpapi

import (
	"errors"
	"net"
	"net/http"

	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/domain"
)

func (a *api) authLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		if !a.Limiter.Allow(r.Context(), "auth_ip", ip) {
			w.Header().Set("Retry-After", "1")
			writeError(w, a.Log, domain.ErrRateLimited)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *api) authError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrUnauthorized):
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(w, http.StatusUnauthorized, errorBody{"unauthorized"})
	case errors.Is(err, auth.ErrConflict):
		writeJSON(w, http.StatusConflict, errorBody{"account_conflict"})
	case errors.Is(err, domain.ErrInvalidInput), errors.Is(err, domain.ErrRateLimited):
		writeError(w, a.Log, err)
	default:
		// Database/bcrypt errors may carry untrusted details: never log credentials.
		a.Log.Error("auth operation unavailable")
		writeJSON(w, http.StatusServiceUnavailable, errorBody{"auth_unavailable"})
	}
}
func (a *api) register(w http.ResponseWriter, r *http.Request) {
	var req auth.Credentials
	if err := decodeJSON(r, &req); err != nil {
		a.authError(w, err)
		return
	}
	tokens, err := a.Auth.Register(r.Context(), req)
	if err != nil {
		a.authError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, tokens)
}
func (a *api) login(w http.ResponseWriter, r *http.Request) {
	var req auth.Credentials
	if err := decodeJSON(r, &req); err != nil {
		a.authError(w, err)
		return
	}
	if !a.Limiter.Allow(r.Context(), "auth_username", req.Username) {
		a.authError(w, domain.ErrRateLimited)
		return
	}
	tokens, err := a.Auth.Login(r.Context(), req)
	if err != nil {
		a.authError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}
func (a *api) refresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := decodeJSON(r, &req); err != nil {
		a.authError(w, err)
		return
	}
	tokens, err := a.Auth.Refresh(r.Context(), req.RefreshToken)
	if err != nil {
		a.authError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}
func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, _ := auth.FromContext(r.Context())
	if err := a.Auth.Logout(r.Context(), p); err != nil {
		a.authError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
