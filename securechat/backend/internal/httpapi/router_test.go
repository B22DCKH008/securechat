package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccessLogOmitsClientPathQueryAndBody(t *testing.T) {
	const marker = "REVIEW_SYNTHETIC_SECRET"
	for _, tc := range []struct {
		name, method, path, wantPath string
		status                       int
	}{
		{"matched", "GET", "/v1/conversations/" + marker + "/messages", "/v1/conversations/{id}/messages", 204},
		{"unmatched", "GET", "/unknown/" + marker, "unmatched", 404},
		{"method", "DELETE", "/v1/conversations/" + marker + "/messages", "unmatched", 405},
		{"escaped", "GET", "/v1/conversations/%52EVIEW_SYNTHETIC_SECRET/messages", "/v1/conversations/{id}/messages", 204},
		{"redirect", "GET", "/unknown//" + marker, "unmatched", 307},
		{"connect_redirect", "CONNECT", "/tree/" + marker, "unmatched", 307},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			mux := http.NewServeMux()
			mux.HandleFunc("GET /v1/conversations/{id}/messages", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
			mux.HandleFunc("/tree/{id}/", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
			req := httptest.NewRequest(tc.method, tc.path+"?access_token="+marker, strings.NewReader(marker))
			w := httptest.NewRecorder()
			requestLogger(slog.New(slog.NewJSONHandler(&logs, nil)), mux).ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d", w.Code, tc.status)
			}
			if strings.Contains(logs.String(), marker) {
				t.Fatal("client-controlled secret reached access log")
			}
			var entry struct {
				Path   string `json:"path"`
				Status int    `json:"status"`
			}
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if entry.Path != tc.wantPath || entry.Status != tc.status {
				t.Fatalf("log: %+v", entry)
			}
		})
	}
}
