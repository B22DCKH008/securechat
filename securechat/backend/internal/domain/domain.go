// Package domain holds core types shared by store, service and transport layers.
// The server only ever handles ciphertext + minimal metadata (SC6).
package domain

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrNotMember      = errors.New("user is not a member of conversation") // SC5
	ErrInvalidInput   = errors.New("invalid input")
	ErrRateLimited    = errors.New("rate limited")
	ErrNoPreKeyBundle = errors.New("no pre-key bundle for user")
)

// DeliveryState is kept separate from server acceptance (RS6).
type DeliveryState string

const (
	StateAccepted  DeliveryState = "accepted"  // committed in PostgreSQL
	StateDelivered DeliveryState = "delivered" // recipient device received + stored
	StateRead      DeliveryState = "read"      // recipient opened it
)

func (s DeliveryState) ValidReceipt() bool { return s == StateDelivered || s == StateRead }

type User struct {
	ID        uuid.UUID `json:"id"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"createdAt"`
}

type Conversation struct {
	ID        uuid.UUID   `json:"id"`
	Kind      string      `json:"kind"` // "direct" in MVP; "group" is BONUS (RS31-35)
	LastSeq   int64       `json:"lastSeq"`
	Members   []uuid.UUID `json:"members"`
	CreatedAt time.Time   `json:"createdAt"`
}

// Message is what the server persists. Ciphertext is opaque to the server.
type Message struct {
	ID              uuid.UUID       `json:"messageId"`
	ClientMessageID string          `json:"clientMessageId"`
	ConversationID  uuid.UUID       `json:"conversationId"`
	Seq             int64           `json:"seq"` // authoritative order (RS5, KF4)
	SenderID        uuid.UUID       `json:"senderId"`
	Ciphertext      []byte          `json:"ciphertext"`                // base64 in JSON
	ProtocolMeta    json.RawMessage `json:"protocolMeta"`              // e.g. {"type":3,"deviceId":1,"registrationId":..}
	ClientCreatedAt *time.Time      `json:"clientCreatedAt,omitempty"` // reference only
	CreatedAt       time.Time       `json:"createdAt"`
}

// SendCommand is the validated input for sending a message.
// SenderID MUST come from the authenticated identity, never from the client body.
type SendCommand struct {
	SenderID        uuid.UUID
	ClientMessageID string
	ConversationID  uuid.UUID
	Ciphertext      []byte
	ProtocolMeta    json.RawMessage
	ClientCreatedAt *time.Time
}

func (c SendCommand) Validate(maxCiphertext int) error {
	switch {
	case c.SenderID == uuid.Nil, c.ConversationID == uuid.Nil:
		return ErrInvalidInput
	case len(c.ClientMessageID) == 0 || len(c.ClientMessageID) > 64:
		return ErrInvalidInput
	case len(c.Ciphertext) == 0 || len(c.Ciphertext) > maxCiphertext:
		return ErrInvalidInput
	}
	return nil
}

// SendResult is returned to the sender as the server-accepted ACK.
type SendResult struct {
	Message   Message
	Duplicate bool // true when clientMessageId was already accepted (RS2)
}

type Receipt struct {
	MessageID      uuid.UUID     `json:"messageId"`
	ConversationID uuid.UUID     `json:"conversationId"`
	Seq            int64         `json:"seq"`
	SenderID       uuid.UUID     `json:"senderId"`
	RecipientID    uuid.UUID     `json:"recipientId"`
	State          DeliveryState `json:"state"`
	At             time.Time     `json:"at"`
}

// PreKeyBundle holds PUBLIC key material only (SC2). Private keys never leave the client.
type PreKeyBundle struct {
	UserID                uuid.UUID `json:"userId"`
	DeviceID              int       `json:"deviceId"`
	RegistrationID        int       `json:"registrationId"`
	IdentityKey           []byte    `json:"identityKey"`
	SignedPreKeyID        int       `json:"signedPreKeyId"`
	SignedPreKey          []byte    `json:"signedPreKey"`
	SignedPreKeySignature []byte    `json:"signedPreKeySignature"`
	OneTimePreKeyID       *int      `json:"oneTimePreKeyId,omitempty"`
	OneTimePreKey         []byte    `json:"oneTimePreKey,omitempty"`
}

type OneTimePreKey struct {
	KeyID     int    `json:"keyId"`
	PublicKey []byte `json:"publicKey"`
}
