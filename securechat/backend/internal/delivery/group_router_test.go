package delivery

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/events"
	"github.com/securechat/backend/internal/gateway"
)

type framePusher struct{ frames map[uuid.UUID][][]byte }

func (p *framePusher) PushToUser(id uuid.UUID, frame []byte) int {
	p.frames[id] = append(p.frames[id], frame)
	return 1
}

func TestRouterGroupPushesEachRecipientOnlyItsCopy(t *testing.T) {
	b, c, d := uuid.New(), uuid.New(), uuid.New()
	copies := []domain.RecipientCiphertext{
		{RecipientID: b, DeviceID: 1, Ciphertext: []byte("for-b"), ProtocolMeta: json.RawMessage(`{"type":3}`)},
		{RecipientID: c, DeviceID: 1, Ciphertext: []byte("for-c"), ProtocolMeta: json.RawMessage(`{"type":1}`)},
	}
	env, err := events.New(events.TypeMessageAccepted, events.MessageAccepted{
		MessageID: uuid.New(), ConversationID: uuid.New(), Seq: 4, SenderID: uuid.New(),
		Recipients: []uuid.UUID{b, c, d}, Ciphertext: []byte{}, ProtocolMeta: json.RawMessage(`{}`),
		AcceptedAt: time.Now(), Ciphertexts: copies,
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	p := &framePusher{frames: map[uuid.UUID][][]byte{}}
	if err := NewRouter(p, 16).Handle(raw); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[uuid.UUID]string{b: "for-b", c: "for-c"} {
		if len(p.frames[id]) != 1 {
			t.Fatalf("recipient got %d frames", len(p.frames[id]))
		}
		var f gateway.Frame
		if err := json.Unmarshal(p.frames[id][0], &f); err != nil || f.Type != gateway.FrameMessage {
			t.Fatal("bad frame")
		}
		var got events.MessageAccepted
		if err := json.Unmarshal(f.Payload, &got); err != nil {
			t.Fatal(err)
		}
		if string(got.Ciphertext) != want || len(got.Ciphertexts) != 0 || got.Seq != 4 {
			t.Fatalf("recipient received %q with %d copies", got.Ciphertext, len(got.Ciphertexts))
		}
		other := "for-c"
		if want == "for-c" {
			other = "for-b"
		}
		if bytes.Contains(p.frames[id][0], []byte(b64(other))) {
			t.Fatal("frame leaks another recipient's ciphertext")
		}
	}
	if len(p.frames[d]) != 0 {
		t.Fatal("recipient without a copy must not get a frame")
	}
}

func TestRouterSystemEventGoesToAllRecipients(t *testing.T) {
	b, c := uuid.New(), uuid.New()
	env, _ := events.New(events.TypeMessageAccepted, events.MessageAccepted{
		MessageID: uuid.New(), ConversationID: uuid.New(), Seq: 1, SenderID: uuid.New(),
		Recipients: []uuid.UUID{b, c}, Ciphertext: []byte{}, Kind: domain.MessageKindSystem,
		System: &domain.SystemEvent{Type: domain.SystemGroupCreated}, AcceptedAt: time.Now(),
	}, time.Now())
	raw, _ := json.Marshal(env)
	p := &framePusher{frames: map[uuid.UUID][][]byte{}}
	if err := NewRouter(p, 16).Handle(raw); err != nil {
		t.Fatal(err)
	}
	if len(p.frames[b]) != 1 || len(p.frames[c]) != 1 || !bytes.Contains(p.frames[b][0], []byte(`"kind":"system"`)) {
		t.Fatal("system event not pushed to every recipient")
	}
}

func TestRouterGroupCopyWithoutCiphertextIsPermanent(t *testing.T) {
	b := uuid.New()
	env, _ := events.New(events.TypeMessageAccepted, events.MessageAccepted{
		MessageID: uuid.New(), Recipients: []uuid.UUID{b},
		Ciphertexts: []domain.RecipientCiphertext{{RecipientID: b}},
	}, time.Now())
	raw, _ := json.Marshal(env)
	err := NewRouter(&framePusher{frames: map[uuid.UUID][][]byte{}}, 16).Handle(raw)
	if _, ok := err.(PermanentError); !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
}

func b64(s string) string {
	out, _ := json.Marshal([]byte(s))
	return string(bytes.Trim(out, `"`))
}
