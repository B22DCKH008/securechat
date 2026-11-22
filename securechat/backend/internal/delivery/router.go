// Package delivery turns pipeline events into WebSocket pushes on THIS instance.
//
// Transport-agnostic: Router.Handle is fed by the Kafka consumer (default) or by
// the Redis Pub/Sub subscriber when DELIVERY_TRANSPORT=redis (KF16, EXP13).
package delivery

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/events"
	"github.com/securechat/backend/internal/gateway"
	"github.com/securechat/backend/internal/metrics"
)

// Pusher is implemented by *gateway.Hub.
type Pusher interface {
	PushToUser(userID uuid.UUID, frame []byte) int
}

type Router struct {
	pusher Pusher
	dedupe *Dedupe
}

func NewRouter(p Pusher, dedupeCapacity int) *Router {
	return &Router{pusher: p, dedupe: NewDedupe(dedupeCapacity)}
}

// PermanentError marks a poison event that must go to the DLQ, not be retried (KF11).
type PermanentError struct{ Err error }

func (e PermanentError) Error() string { return "permanent: " + e.Err.Error() }
func (e PermanentError) Unwrap() error { return e.Err }

// TransientError marks a failure that may succeed later; the consumer routes it
// through chat.retry with backoff + jitter, then to the DLQ (KF11, RS36).
// Any error that is not a PermanentError is treated as transient.
type TransientError struct{ Err error }

func (e TransientError) Error() string { return "transient: " + e.Err.Error() }
func (e TransientError) Unwrap() error { return e.Err }

// Handle processes one raw envelope. Offline recipients are simply skipped:
// the message is already durable in PostgreSQL and will arrive via sync (KF6).
//
// The eventId is remembered only after the typed payload decoded and the push
// was attempted, so a replayed poison/failed event is never reported as an
// already-handled duplicate (KF5). Duplicates are suppressed best-effort only;
// clients still dedupe by messageId/receiptSeq.
func (r *Router) Handle(raw []byte) error {
	env, err := events.Decode(raw)
	if err != nil {
		return PermanentError{err}
	}
	if r.dedupe.Seen(env.EventID) {
		metrics.EventsDeduped.Inc()
		return nil
	}

	switch env.EventType {
	case events.TypeMessageAccepted:
		var p events.MessageAccepted
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return PermanentError{fmt.Errorf("decode MessageAccepted: %w", err)}
		}
		if p.MessageID == uuid.Nil || len(p.Recipients) == 0 {
			return PermanentError{fmt.Errorf("MessageAccepted without messageId/recipients")}
		}
		metrics.StageAcceptedToConsumed.Observe(max(0, time.Since(p.AcceptedAt).Seconds()))
		pushed := 0
		if len(p.Ciphertexts) == 0 {
			frame := gateway.EncodeFrame(gateway.FrameMessage, env.Payload)
			for _, rcpt := range p.Recipients {
				pushed += r.pusher.PushToUser(rcpt, frame)
			}
		} else {
			// Group pairwise fan-out: each recipient gets only its own copy.
			frames, err := perRecipientFrames(env.Payload, p.Ciphertexts)
			if err != nil {
				return PermanentError{err}
			}
			for _, rcpt := range p.Recipients {
				if frame, ok := frames[rcpt]; ok {
					pushed += r.pusher.PushToUser(rcpt, frame)
				}
			}
		}
		if pushed > 0 {
			metrics.StageAcceptedToPushed.Observe(max(0, time.Since(p.AcceptedAt).Seconds()))
		}
		// TODO(BE2, RS9): push to sender's OTHER devices once per-device ciphertext exists.

	case events.TypeMessageDelivered, events.TypeMessageRead:
		var p events.Receipt
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return PermanentError{fmt.Errorf("decode Receipt: %w", err)}
		}
		if p.MessageID == uuid.Nil || p.SenderID == uuid.Nil {
			return PermanentError{fmt.Errorf("receipt without messageId/senderId")}
		}
		r.pusher.PushToUser(p.SenderID, gateway.EncodeFrame(gateway.FrameReceipt, env.Payload))

	default:
		// Unknown type from a newer producer: ignore (forward compatibility, KF13).
	}
	r.dedupe.Remember(env.EventID)
	return nil
}

// perRecipientFrames rewrites a group MessageAccepted payload for each
// recipient: ciphertext/protocolMeta become that recipient's copy and the full
// ciphertexts list is removed. Unknown fields are preserved (KF13).
func perRecipientFrames(payload json.RawMessage, copies []domain.RecipientCiphertext) (map[uuid.UUID][]byte, error) {
	var base map[string]json.RawMessage
	if err := json.Unmarshal(payload, &base); err != nil {
		return nil, fmt.Errorf("decode group payload: %w", err)
	}
	delete(base, "ciphertexts")
	out := make(map[uuid.UUID][]byte, len(copies))
	for _, c := range copies {
		if c.RecipientID == uuid.Nil || len(c.Ciphertext) == 0 {
			return nil, fmt.Errorf("group copy without recipientId/ciphertext")
		}
		ct, _ := json.Marshal(c.Ciphertext)
		base["ciphertext"] = ct
		meta := c.ProtocolMeta
		if len(meta) == 0 {
			meta = json.RawMessage(`{}`)
		}
		base["protocolMeta"] = meta
		raw, err := json.Marshal(base)
		if err != nil {
			return nil, err
		}
		out[c.RecipientID] = gateway.EncodeFrame(gateway.FrameMessage, raw)
	}
	return out, nil
}
