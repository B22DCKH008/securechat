package gateway

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Frame is the single WebSocket envelope in both directions.
//
// client → server types: "send", "ack", "ping"
// server → client types: "accepted", "message", "receipt", "error", "pong", "resync"
type Frame struct {
	Type    string          `json:"type"`
	Ref     string          `json:"ref,omitempty"` // client correlation id, echoed back
	Payload json.RawMessage `json:"payload,omitempty"`
}

const (
	FrameSend     = "send"
	FrameAck      = "ack"
	FramePing     = "ping"
	FrameAccepted = "accepted"
	FrameMessage  = "message"
	FrameReceipt  = "receipt"
	FrameError    = "error"
	FramePong     = "pong"
	// FrameResync tells the client to call POST /v1/sync (e.g. after it was
	// dropped as a slow consumer, or the gateway detected a gap).
	FrameResync = "resync"
)

type SendPayload struct {
	ClientMessageID string          `json:"clientMessageId"`
	ConversationID  uuid.UUID       `json:"conversationId"`
	Ciphertext      []byte          `json:"ciphertext"` // base64
	ProtocolMeta    json.RawMessage `json:"protocolMeta"`
	ClientCreatedAt *time.Time      `json:"clientCreatedAt,omitempty"`
	// NOTE: no senderId – the server uses the authenticated identity.
}

type AcceptedPayload struct {
	ClientMessageID string    `json:"clientMessageId"`
	MessageID       uuid.UUID `json:"messageId"`
	ConversationID  uuid.UUID `json:"conversationId"`
	Seq             int64     `json:"seq"`
	Duplicate       bool      `json:"duplicate"`
	State           string    `json:"state"` // always "accepted"
}

type AckPayload struct {
	MessageID uuid.UUID `json:"messageId"`
	State     string    `json:"state"` // "delivered" | "read"
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func encode(typ, ref string, payload any) []byte {
	var raw json.RawMessage
	if payload != nil {
		raw, _ = json.Marshal(payload)
	}
	b, _ := json.Marshal(Frame{Type: typ, Ref: ref, Payload: raw})
	return b
}

// EncodeFrame is used by the delivery consumer to build push frames.
func EncodeFrame(typ string, payload json.RawMessage) []byte {
	b, _ := json.Marshal(Frame{Type: typ, Payload: payload})
	return b
}
