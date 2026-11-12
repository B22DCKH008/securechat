// Package logger builds a structured JSON logger that redacts sensitive fields (INF3, SC7).
//
// Rule for the whole codebase: NEVER log ciphertext, plaintext, keys, tokens or
// full request URLs (WS token lives in the query string). Redaction below is a
// safety net, not a licence to log payloads.
package logger

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// sensitiveKeys are attribute keys whose values are always replaced.
var sensitiveKeys = map[string]struct{}{
	"ciphertext": {}, "plaintext": {}, "body": {}, "payload": {},
	"token": {}, "access_token": {}, "authorization": {}, "password": {},
	"identity_key": {}, "private_key": {}, "prekey": {}, "signed_prekey": {},
	"jwt_secret": {}, "secret": {},
	"accesstoken": {}, "refreshtoken": {}, "refresh_token": {},
	"password_hash": {}, "refresh_token_hash": {}, "privatekey": {},
}

const redacted = "[REDACTED]"

func New(level string) *slog.Logger {
	return NewWithWriter(os.Stdout, level)
}

func NewWithWriter(w io.Writer, level string) *slog.Logger {
	var lv slog.Level
	_ = lv.UnmarshalText([]byte(level))
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:       lv,
		ReplaceAttr: redact,
	})
	return slog.New(h)
}

func redact(_ []string, a slog.Attr) slog.Attr {
	if _, ok := sensitiveKeys[strings.ToLower(a.Key)]; ok {
		return slog.String(a.Key, redacted)
	}
	return a
}
