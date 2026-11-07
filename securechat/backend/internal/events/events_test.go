package events

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	p := MessageAccepted{MessageID: uuid.New(), ConversationID: uuid.New(), Seq: 7, Ciphertext: []byte{1, 2, 3}}
	env, err := New(TypeMessageAccepted, p, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)

	got, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.EventID != env.EventID || got.EventType != TypeMessageAccepted {
		t.Fatalf("envelope mismatch: %+v", got)
	}
	var back MessageAccepted
	if err := json.Unmarshal(got.Payload, &back); err != nil || back.Seq != 7 {
		t.Fatalf("payload mismatch: %+v err=%v", back, err)
	}
}

func TestDecodeRejectsMissingID(t *testing.T) {
	if _, err := Decode([]byte(`{"eventType":"MessageAccepted","schemaVersion":1}`)); err == nil {
		t.Fatal("expected error for missing eventId")
	}
}

func TestDecodeIgnoresUnknownFields(t *testing.T) {
	// Backward compatibility: a newer producer may add fields (KF13).
	raw := `{"eventId":"` + uuid.NewString() + `","eventType":"MessageRead","schemaVersion":2,"occurredAt":"2026-01-01T00:00:00Z","payload":{},"newField":true}`
	if _, err := Decode([]byte(raw)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
