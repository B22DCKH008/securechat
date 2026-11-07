package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/domain"
)

type errorBody struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, log *slog.Logger, err error) {
	switch {
	case errors.Is(err, domain.ErrInvalidInput):
		writeJSON(w, http.StatusBadRequest, errorBody{"invalid_input"})
	case errors.Is(err, domain.ErrNotMember):
		writeJSON(w, http.StatusForbidden, errorBody{"forbidden"})
	case errors.Is(err, domain.ErrNotFound), errors.Is(err, domain.ErrNoPreKeyBundle):
		writeJSON(w, http.StatusNotFound, errorBody{"not_found"})
	case errors.Is(err, domain.ErrRateLimited):
		writeJSON(w, http.StatusTooManyRequests, errorBody{"rate_limited"})
	default:
		log.Error("internal error", "err", err)
		writeJSON(w, http.StatusInternalServerError, errorBody{"internal"})
	}
}

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return domain.ErrInvalidInput
	}
	return nil
}

func pathUUID(r *http.Request, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(r.PathValue(name))
	if err != nil {
		return uuid.Nil, domain.ErrInvalidInput
	}
	return id, nil
}

func queryInt(r *http.Request, name string, def int64) int64 {
	if v, err := strconv.ParseInt(r.URL.Query().Get(name), 10, 64); err == nil {
		return v
	}
	return def
}
