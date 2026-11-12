//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/gateway"
)

func TestWebSocketLargeCiphertextPersistsAndRetriesOverREST(t *testing.T) {
	f := newFixture(t)
	s, _, _ := server(t, f)
	a := register(t, s, "budget_alice")
	conv, err := f.svc.CreateDirect(ctx, a.UserID, f.b)
	if err != nil {
		t.Fatal(err)
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(callCtx, "ws"+strings.TrimPrefix(s.URL, "http")+"/ws?access_token="+a.AccessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	read := func() gateway.Frame {
		t.Helper()
		_, data, err := ws.Read(callCtx)
		if err != nil {
			t.Fatal(err)
		}
		var frame gateway.Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatal(err)
		}
		return frame
	}
	if read().Type != gateway.FrameResync {
		t.Fatal("missing resync")
	}
	ciphertext := bytes.Repeat([]byte{7}, 65536)
	meta := json.RawMessage(`{"type":3,"padding":"` + strings.Repeat("x", 4000) + `"}`)
	payload := gateway.SendPayload{ClientMessageID: "large-ws", ConversationID: conv.ID, Ciphertext: ciphertext, ProtocolMeta: meta}
	send := func() gateway.Frame {
		t.Helper()
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if err := ws.Write(callCtx, websocket.MessageText, gateway.EncodeFrame(gateway.FrameSend, raw)); err != nil {
			t.Fatal(err)
		}
		return read()
	}
	frame := send()
	var accepted gateway.AcceptedPayload
	if err := json.Unmarshal(frame.Payload, &accepted); err != nil {
		t.Fatal(err)
	}
	if frame.Type != gateway.FrameAccepted || accepted.Seq != 1 || accepted.Duplicate {
		t.Fatalf("not accepted: %+v", frame)
	}
	path := "/v1/conversations/" + conv.ID.String() + "/messages"
	request(t, s.URL, "POST", path, a.AccessToken, map[string]any{"clientMessageId": payload.ClientMessageID, "ciphertext": ciphertext, "protocolMeta": meta}, 200)
	var stored []byte
	if err := f.pool.QueryRow(ctx, `SELECT ciphertext FROM messages WHERE id=$1`, accepted.MessageID).Scan(&stored); err != nil || !bytes.Equal(stored, ciphertext) {
		t.Fatalf("ciphertext not persisted intact: %v", err)
	}
	payload.ClientMessageID = "oversized-ws"
	payload.Ciphertext = append(ciphertext, 1)
	frame = send()
	var rejected gateway.ErrorPayload
	if err := json.Unmarshal(frame.Payload, &rejected); err != nil {
		t.Fatal(err)
	}
	if frame.Type != gateway.FrameError || rejected.Code != "invalid" {
		t.Fatalf("oversized send: %+v", frame)
	}
	request(t, s.URL, "POST", path, a.AccessToken, map[string]any{"clientMessageId": payload.ClientMessageID, "ciphertext": payload.Ciphertext, "protocolMeta": meta}, 400)
	if number(t, f.pool, `SELECT count(*) FROM messages WHERE conversation_id=$1`, conv.ID) != 1 || number(t, f.pool, `SELECT last_seq FROM conversations WHERE id=$1`, conv.ID) != 1 || number(t, f.pool, `SELECT count(*) FROM outbox`) != 1 {
		t.Fatal("retry or rejected payload changed message/seq/outbox")
	}
}

func TestRetryJSONBNumbersAndTimestampPrecision(t *testing.T) {
	f := newFixture(t)
	cmd := f.command("numbers")
	at := time.Now()
	cmd.ClientCreatedAt = &at
	cmd.ProtocolMeta = json.RawMessage(`{"n":1e4,"big":9007199254740993}`)
	first, e := f.svc.Send(ctx, cmd)
	if e != nil {
		t.Fatal(e)
	}
	second, e := f.svc.Send(ctx, cmd)
	if e != nil || !second.Duplicate || first.Message.ID != second.Message.ID {
		t.Fatalf("original retry mismatch: %v", e)
	}
	cmd.ProtocolMeta = json.RawMessage(`{"big":9007199254740993,"n":10000.0}`)
	if _, e = f.svc.Send(ctx, cmd); e != nil {
		t.Fatalf("JSONB-equivalent retry: %v", e)
	}
	cmd.ProtocolMeta = json.RawMessage(`{"big":9007199254740992,"n":10000}`)
	if _, e = f.svc.Send(ctx, cmd); !errors.Is(e, domain.ErrConflict) {
		t.Fatal("large integers lost precision")
	}
}
func TestMessagePageByteBudgetAndInputBounds(t *testing.T) {
	f := newFixture(t)
	for i := range 18 {
		cmd := f.command(fmt.Sprint(i))
		cmd.Ciphertext = bytes.Repeat([]byte{byte(i)}, 65536)
		if _, e := f.svc.Send(ctx, cmd); e != nil {
			t.Fatal(e)
		}
	}
	pages, e := f.svc.Sync(ctx, f.b, nil, 200)
	if e != nil || len(pages) != 1 {
		t.Fatalf("sync: %v", e)
	}
	if !pages[0].HasMore || len(pages[0].Messages) >= 18 {
		t.Fatal("message byte budget not applied")
	}
	encoded, e := json.Marshal(pages[0].Messages)
	if e != nil || len(encoded) > 1<<20 {
		t.Fatal("message page exceeds budget")
	}
	more, e := f.svc.Sync(ctx, f.b, map[uuid.UUID]int64{f.conv: pages[0].NextCursor}, 200)
	if e != nil || len(more) != 1 || len(more[0].Messages)+len(pages[0].Messages) != 18 {
		t.Fatal("budget truncation lost messages")
	}
	cmd := f.command("badmeta")
	cmd.ProtocolMeta = json.RawMessage(`null`)
	if _, e = f.svc.Send(ctx, cmd); !errors.Is(e, domain.ErrInvalidInput) {
		t.Fatal("null metadata accepted")
	}
	cmd.ProtocolMeta = json.RawMessage(`{"type":3}`)
	cmd.Ciphertext = bytes.Repeat([]byte{1}, 65537)
	if _, e = f.svc.Send(ctx, cmd); !errors.Is(e, domain.ErrInvalidInput) {
		t.Fatal("oversized ciphertext accepted")
	}
	if _, e = f.svc.Sync(ctx, f.b, map[uuid.UUID]int64{f.conv: -1}, 50); !errors.Is(e, domain.ErrInvalidInput) {
		t.Fatal("negative cursor accepted")
	}
}
func TestPasswordlessAccountAndKeyDeviceScope(t *testing.T) {
	f := newFixture(t)
	s, _, _ := server(t, f)
	request(t, s.URL, "POST", "/v1/auth/register", "", auth.Credentials{Username: "user0", Password: "correct-password-123"}, 409)
	request(t, s.URL, "POST", "/v1/auth/login", "", auth.Credentials{Username: "user0", Password: "correct-password-123"}, 401)
	a := register(t, s, "device_owner")
	request(t, s.URL, "PUT", "/v1/keys/bundle", a.AccessToken, map[string]any{"deviceId": 2, "registrationId": 1, "identityKey": []byte{1}, "signedPreKeyId": 1, "signedPreKey": []byte{1}, "signedPreKeySignature": []byte{1}, "oneTimePreKeys": []any{}}, 403)
	request(t, s.URL, "GET", "/v1/conversations/"+f.conv.String()+"/messages?before_seq=invalid", a.AccessToken, nil, 400)
}
