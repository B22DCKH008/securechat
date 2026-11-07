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

// Handle processes one raw envelope. Offline recipients are simply skipped:
// the message is already durable in PostgreSQL and will arrive via sync (KF6).
func (r *Router) Handle(raw []byte) error {
	env, err := events.Decode(raw)
	if err != nil {
		return PermanentError{err}
	}
	if !r.dedupe.FirstSeen(env.EventID) {
		metrics.EventsDeduped.Inc()
		return nil
	}

	switch env.EventType {
	case events.TypeMessageAccepted:
		var p events.MessageAccepted
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return PermanentError{fmt.Errorf("decode MessageAccepted: %w", err)}
		}
		metrics.StageAcceptedToConsumed.Observe(time.Since(p.AcceptedAt).Seconds())
		frame := gateway.EncodeFrame(gateway.FrameMessage, env.Payload)
		pushed := 0
		for _, rcpt := range p.Recipients {
			pushed += r.pusher.PushToUser(rcpt, frame)
		}
		if pushed > 0 {
			metrics.StageAcceptedToPushed.Observe(time.Since(p.AcceptedAt).Seconds())
		}
		// TODO(BE2, RS9): push to sender's OTHER devices once per-device ciphertext exists.

	case events.TypeMessageDelivered, events.TypeMessageRead:
		var p events.Receipt
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return PermanentError{fmt.Errorf("decode Receipt: %w", err)}
		}
		r.pusher.PushToUser(p.SenderID, gateway.EncodeFrame(gateway.FrameReceipt, env.Payload))

	default:
		// Unknown type from a newer producer: ignore (forward compatibility, KF13).
	}
	return nil
}
