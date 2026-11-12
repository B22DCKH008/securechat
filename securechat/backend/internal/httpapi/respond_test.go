package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeRejectsUnknownTrailingAndOversizedJSON(t *testing.T) {
	for _, body := range []string{`{"state":"read","senderId":"spoof"}`, `{"state":"read"}{"state":"delivered"}`, `{"state":"` + strings.Repeat("x", 1<<20) + `"}`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var req struct {
			State string `json:"state"`
		}
		if decodeJSON(r, &req) == nil {
			t.Fatal("invalid body accepted")
		}
	}
}
func TestCursorQueryRejectsMalformedAndRepeatedValues(t *testing.T) {
	for _, query := range []string{"?before_seq=x", "?before_seq=1&before_seq=2", "?before_seq=9223372036854775808", "?before_seq="} {
		if _, err := queryInt(httptest.NewRequest("GET", "/"+query, nil), "before_seq", 0); err == nil {
			t.Fatalf("accepted %s", query)
		}
	}
}
