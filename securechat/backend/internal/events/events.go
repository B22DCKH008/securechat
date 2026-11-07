// Package events defines the Kafka event contract (doc §7.3, KF13).
//
// Compatibility rule: only ADD fields; never change the meaning of an existing
// field. Bump SchemaVersion when adding fields consumers should know about.
package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type Type string

const (
	TypeMessageAccepted  Type = "MessageAccepted"
	TypeMessageDelivered Type = "MessageDelivered"
	TypeMessageRead      Type = "MessageRead"
)

const SchemaVersion = 1

// Envelope wraps every event. EventID is the dedupe key (KF5).
type Envelope struct {
	EventID       uuid.UUID       `json:"eventId"`
	EventType     Type            `json:"eventType"`
	SchemaVersion int             `json:"schemaVersion"`
	OccurredAt    time.Time       `json:"occurredAt"`
	Payload       json.RawMessage `json:"payload"`
}

// MessageAccepted payload. Contains ciphertext ONLY – no plaintext (KF12).
type MessageAccepted struct {
	MessageID       uuid.UUID       `json:"messageId"`
	ClientMessageID string          `json:"clientMessageId"`
	ConversationID  uuid.UUID       `json:"conversationId"`
	Seq             int64           `json:"seq"`
	SenderID        uuid.UUID       `json:"senderId"`
	Recipients      []uuid.UUID     `json:"recipients"` // 1:1 → one element; group-ready (KF17)
	Ciphertext      []byte          `json:"ciphertext"`
	ProtocolMeta    json.RawMessage `json:"protocolMeta"`
	AcceptedAt      time.Time       `json:"acceptedAt"` // for latency breakdown (EXP11)
}

// Receipt payload for MessageDelivered / MessageRead.
// SenderID is an additive field (v1) so the gateway can route back to the sender.
type Receipt struct {
	MessageID      uuid.UUID `json:"messageId"`
	ConversationID uuid.UUID `json:"conversationId"`
	Seq            int64     `json:"seq"`
	RecipientID    uuid.UUID `json:"recipientId"`
	SenderID       uuid.UUID `json:"senderId"`
	State          string    `json:"state"`
	At             time.Time `json:"at"`
}

// New builds an envelope with a fresh eventId.
func New(t Type, payload any, now time.Time) (Envelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, fmt.Errorf("marshal payload: %w", err)
	}
	return Envelope{
		EventID:       uuid.New(),
		EventType:     t,
		SchemaVersion: SchemaVersion,
		OccurredAt:    now.UTC(),
		Payload:       raw,
	}, nil
}

// Decode parses an envelope and rejects unknown future major versions.
func Decode(b []byte) (Envelope, error) {
	var e Envelope
	if err := json.Unmarshal(b, &e); err != nil {
		return e, fmt.Errorf("decode envelope: %w", err)
	}
	if e.EventID == uuid.Nil || e.EventType == "" {
		return e, fmt.Errorf("envelope missing eventId/eventType")
	}
	if e.SchemaVersion < 1 {
		return e, fmt.Errorf("unsupported schemaVersion %d", e.SchemaVersion)
	}
	return e, nil
}
