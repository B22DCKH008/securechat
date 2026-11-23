// Package domain holds core types shared by store, service and transport layers.
// The server only ever handles ciphertext + minimal metadata (SC6).
package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrNotMember      = errors.New("user is not a member of conversation") // SC5
	ErrInvalidInput   = errors.New("invalid input")
	ErrConflict       = errors.New("clientMessageId reused with different payload")
	ErrRateLimited    = errors.New("rate limited")
	ErrNoPreKeyBundle = errors.New("no pre-key bundle for user")
	// ErrMembershipChanged: a group send did not carry exactly one ciphertext per
	// current member. Nothing was stored, so the client refetches members,
	// encrypts again and may retry with the same clientMessageId.
	ErrMembershipChanged = errors.New("recipient ciphertexts do not match current members")
)

const (
	KindDirect = "direct"
	KindGroup  = "group"

	MessageKindText   = "message"
	MessageKindSystem = "system"

	RoleOwner  = "owner"
	RoleMember = "member"

	// MaxGroupMembers bounds pairwise fan-out: one ciphertext per member per send.
	MaxGroupMembers = 32
	MaxGroupTitle   = 64

	systemClientPrefix = "sys:"
)

// System event types carried by kind="system" messages.
const (
	SystemGroupCreated  = "group_created"
	SystemMembersAdded  = "members_added"
	SystemMemberRemoved = "member_removed"
	SystemMemberLeft    = "member_left"
	SystemTitleChanged  = "title_changed"
)

// SystemEvent is server-generated membership metadata (never message content).
type SystemEvent struct {
	Type     string      `json:"type"`
	ActorID  uuid.UUID   `json:"actorId"`
	UserIDs  []uuid.UUID `json:"userIds,omitempty"`
	Title    string      `json:"title,omitempty"`
	NewOwner *uuid.UUID  `json:"newOwnerId,omitempty"`
}

// SystemClientMessageID is reserved for server-generated messages.
func SystemClientMessageID() string { return systemClientPrefix + uuid.NewString() }

// RecipientCiphertext is one pairwise Signal ciphertext for one group member.
type RecipientCiphertext struct {
	RecipientID  uuid.UUID       `json:"recipientId"`
	DeviceID     int             `json:"deviceId"`
	Ciphertext   []byte          `json:"ciphertext"`
	ProtocolMeta json.RawMessage `json:"protocolMeta,omitempty"`
}

type Member struct {
	UserID    uuid.UUID `json:"userId"`
	Role      string    `json:"role"`
	JoinedSeq int64     `json:"joinedSeq"`
	JoinedAt  time.Time `json:"joinedAt"`
}

// Departure tells a removed member's client that a conversation is gone.
type Departure struct {
	ConversationID uuid.UUID `json:"conversationId"`
	LeftSeq        int64     `json:"leftSeq"`
	LeftAt         time.Time `json:"leftAt"`
}

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
	Kind      string      `json:"kind"` // "direct" | "group" (pairwise fan-out)
	Title     *string     `json:"title,omitempty"`
	CreatedBy *uuid.UUID  `json:"createdBy,omitempty"`
	LastSeq   int64       `json:"lastSeq"`
	JoinedSeq int64       `json:"joinedSeq,omitempty"` // viewer sees seq > joinedSeq
	Members   []uuid.UUID `json:"members"`
	CreatedAt time.Time   `json:"createdAt"`
}

// Message is what the server persists. Ciphertext is opaque to the server.
// For group messages the ciphertext/protocolMeta returned to a reader are that
// reader's pairwise copy; the sender's own view has an empty ciphertext.
type Message struct {
	ID              uuid.UUID       `json:"messageId"`
	Kind            string          `json:"kind"` // "message" | "system"
	ClientMessageID string          `json:"clientMessageId"`
	ConversationID  uuid.UUID       `json:"conversationId"`
	Seq             int64           `json:"seq"` // authoritative order (RS5, KF4)
	SenderID        uuid.UUID       `json:"senderId"`
	Ciphertext      []byte          `json:"ciphertext"`                // base64 in JSON
	ProtocolMeta    json.RawMessage `json:"protocolMeta"`              // e.g. {"type":3,"deviceId":1,"registrationId":..}
	ClientCreatedAt *time.Time      `json:"clientCreatedAt,omitempty"` // reference only
	System          *SystemEvent    `json:"system,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
}

// SendCommand is the validated input for sending a message.
// SenderID MUST come from the authenticated identity, never from the client body.
type SendCommand struct {
	SenderID        uuid.UUID
	ClientMessageID string
	ConversationID  uuid.UUID
	Ciphertext      []byte // direct conversations
	// Ciphertexts is used for group conversations instead of Ciphertext:
	// exactly one entry per current member other than the sender.
	Ciphertexts     []RecipientCiphertext
	ProtocolMeta    json.RawMessage
	ClientCreatedAt *time.Time
}

// IsGroup reports whether the command carries pairwise group ciphertexts.
func (c SendCommand) IsGroup() bool { return len(c.Ciphertexts) > 0 }

// Validate checks shape and size. maxCiphertext bounds a direct ciphertext and,
// for a group send, the sum of all copies and their metadata, so one group
// send fits the same WebSocket frame and Kafka record budget as a direct one.
func (c SendCommand) Validate(maxCiphertext int) error {
	switch {
	case c.SenderID == uuid.Nil, c.ConversationID == uuid.Nil:
		return ErrInvalidInput
	case len(c.ClientMessageID) == 0 || len(c.ClientMessageID) > 64:
		return ErrInvalidInput
	case strings.HasPrefix(c.ClientMessageID, systemClientPrefix):
		return ErrInvalidInput
	case len(c.ProtocolMeta) > 4096 || !validMeta(c.ProtocolMeta):
		return ErrInvalidInput
	}
	if !c.IsGroup() {
		if len(c.Ciphertext) == 0 || len(c.Ciphertext) > maxCiphertext {
			return ErrInvalidInput
		}
		return nil
	}
	if len(c.Ciphertext) > 0 || len(c.Ciphertexts) > MaxGroupMembers-1 {
		return ErrInvalidInput
	}
	seen := make(map[uuid.UUID]bool, len(c.Ciphertexts))
	total := 0
	for _, rc := range c.Ciphertexts {
		switch {
		case rc.RecipientID == uuid.Nil, rc.RecipientID == c.SenderID, seen[rc.RecipientID]:
			return ErrInvalidInput
		case rc.DeviceID < 0, len(rc.Ciphertext) == 0:
			return ErrInvalidInput
		case len(rc.ProtocolMeta) > 1024 || !validMeta(rc.ProtocolMeta):
			return ErrInvalidInput
		}
		seen[rc.RecipientID] = true
		total += len(rc.Ciphertext) + len(rc.ProtocolMeta)
	}
	if total > maxCiphertext {
		return ErrInvalidInput
	}
	return nil
}

// Normalize fills defaults so retries compare equal: deviceId 0 → 1, empty
// protocolMeta → {}.
func (c *SendCommand) Normalize() {
	if len(c.ProtocolMeta) == 0 {
		c.ProtocolMeta = json.RawMessage(`{}`)
	}
	if c.Ciphertext == nil {
		c.Ciphertext = []byte{}
	}
	for i := range c.Ciphertexts {
		if c.Ciphertexts[i].DeviceID == 0 {
			c.Ciphertexts[i].DeviceID = 1
		}
		if len(c.Ciphertexts[i].ProtocolMeta) == 0 {
			c.Ciphertexts[i].ProtocolMeta = json.RawMessage(`{}`)
		}
	}
	if c.ClientCreatedAt != nil {
		at := c.ClientCreatedAt.UTC().Truncate(time.Microsecond)
		c.ClientCreatedAt = &at
	}
}

func validMeta(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(raw, &object) == nil && object != nil
}

// ValidGroupTitle trims and bounds a group title.
func ValidGroupTitle(title string) (string, bool) {
	title = strings.TrimSpace(title)
	n := len([]rune(title))
	return title, n >= 1 && n <= MaxGroupTitle
}

// SendResult is returned to the sender as the server-accepted ACK.
type SendResult struct {
	Message   Message
	Duplicate bool // true when clientMessageId was already accepted (RS2)
}

type Receipt struct {
	ReceiptSeq     int64         `json:"receiptSeq"`
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
