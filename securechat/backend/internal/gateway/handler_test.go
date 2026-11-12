package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/config"
	"github.com/securechat/backend/internal/domain"
)

type budgetMessenger struct {
	max  int
	user uuid.UUID
}

func (m budgetMessenger) Send(_ context.Context, cmd domain.SendCommand) (domain.SendResult, error) {
	if err := cmd.Validate(m.max); err != nil {
		return domain.SendResult{}, err
	}
	if cmd.SenderID != m.user {
		return domain.SendResult{}, domain.ErrNotMember
	}
	return domain.SendResult{Message: domain.Message{ID: uuid.New(), ClientMessageID: cmd.ClientMessageID, ConversationID: cmd.ConversationID, Seq: 1}}, nil
}
func (budgetMessenger) Acknowledge(context.Context, uuid.UUID, uuid.UUID, domain.DeliveryState) error {
	return nil
}

type budgetDependencies struct{ user uuid.UUID }

func (budgetDependencies) Register(context.Context, uuid.UUID, string) error   { return nil }
func (budgetDependencies) Refresh(context.Context, uuid.UUID) error            { return nil }
func (budgetDependencies) Unregister(context.Context, uuid.UUID, string) error { return nil }
func (budgetDependencies) Allow(context.Context, string, string) bool          { return true }
func (d budgetDependencies) Verify(context.Context, string) (auth.Principal, error) {
	return auth.Principal{UserID: d.user}, nil
}

func TestWebSocketCiphertextAndFrameBudgets(t *testing.T) {
	t.Setenv("JWT_SECRET", strings.Repeat("s", 32))
	t.Setenv("WS_MAX_MESSAGE_BYTES", "65536")
	t.Setenv("WS_MAX_FRAME_BYTES", "131072")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	d := budgetDependencies{user: uuid.New()}
	hub := NewHub(5)
	h := NewHandler(hub, budgetMessenger{int(cfg.WSMaxMessageBytes), d.user}, d, d, d, Options{
		AllowedOrigins: []string{"*"}, PingInterval: time.Hour, PongTimeout: time.Second, SendBuffer: 8,
		MaxFrameBytes: cfg.WSMaxFrameBytes,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s := httptest.NewServer(h)
	t.Cleanup(func() { hub.CloseAll("test done"); s.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(s.URL, "http")+"?access_token=test", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	read := func() Frame {
		t.Helper()
		_, raw, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var frame Frame
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		return frame
	}
	if read().Type != FrameResync {
		t.Fatal("missing resync")
	}
	for _, tc := range []struct {
		size int
		want string
	}{{65536, FrameAccepted}, {65537, FrameError}} {
		payload, err := json.Marshal(SendPayload{ClientMessageID: "boundary", ConversationID: uuid.New(), Ciphertext: bytes.Repeat([]byte{1}, tc.size), ProtocolMeta: json.RawMessage(`{"type":3}`)})
		if err != nil {
			t.Fatal(err)
		}
		if err := ws.Write(ctx, websocket.MessageText, encode(FrameSend, "boundary-ref", json.RawMessage(payload))); err != nil {
			t.Fatal(err)
		}
		frame := read()
		if frame.Type != tc.want || frame.Ref != "boundary-ref" {
			t.Fatalf("size %d: %+v", tc.size, frame)
		}
		if tc.want == FrameError {
			var e ErrorPayload
			if err := json.Unmarshal(frame.Payload, &e); err != nil || e.Code != "invalid" {
				t.Fatalf("expected invalid: %s", frame.Payload)
			}
		}
	}
	// The payload rejection must leave the socket usable.
	if err := ws.Write(ctx, websocket.MessageText, encode(FramePing, "still-open", nil)); err != nil {
		t.Fatal(err)
	}
	if f := read(); f.Type != FramePong || f.Ref != "still-open" {
		t.Fatalf("pong: %+v", f)
	}
	// The transport budget remains bounded independently of decoded ciphertext.
	_ = ws.Write(ctx, websocket.MessageText, bytes.Repeat([]byte{' '}, 131073))
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("oversized frame: %v", err)
	}
}
