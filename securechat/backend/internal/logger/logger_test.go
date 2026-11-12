package logger

import (
	"bytes"
	"strings"
	"testing"
)

func TestRedactsSensitiveFields(t *testing.T) {
	var buf bytes.Buffer
	log := NewWithWriter(&buf, "debug")
	log.Info("send", "ciphertext", "SECRET-BYTES", "token", "abc.def", "conversation_id", "c1")
	log.Info("auth", "accessToken", "ACCESS-SECRET", "refreshToken", "REFRESH-SECRET", "password_hash", "HASH-SECRET")

	out := buf.String()
	for _, leaked := range []string{"SECRET-BYTES", "abc.def", "ACCESS-SECRET", "REFRESH-SECRET", "HASH-SECRET"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("log leaked %q: %s", leaked, out)
		}
	}
	if !strings.Contains(out, "c1") {
		t.Fatalf("non-sensitive field missing: %s", out)
	}
}
