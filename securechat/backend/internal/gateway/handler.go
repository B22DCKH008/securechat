package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/metrics"
)

// Dependencies are interfaces so the gateway is testable without DB/Redis.
type (
	Messenger interface {
		Send(ctx context.Context, cmd domain.SendCommand) (domain.SendResult, error)
		Acknowledge(ctx context.Context, userID, messageID uuid.UUID, state domain.DeliveryState) error
	}
	Presence interface {
		Register(ctx context.Context, userID uuid.UUID, connID string) error
		Refresh(ctx context.Context, userID uuid.UUID) error
		Unregister(ctx context.Context, userID uuid.UUID, connID string) error
	}
	Limiter interface {
		Allow(ctx context.Context, scope, subject string) bool
	}
	TokenVerifier interface {
		Verify(token string) (uuid.UUID, error)
	}
)

type Options struct {
	AllowedOrigins  []string
	PingInterval    time.Duration
	PongTimeout     time.Duration
	SendBuffer      int
	MaxMessageBytes int64
}

type Handler struct {
	hub      *Hub
	msg      Messenger
	presence Presence
	limiter  Limiter
	tokens   TokenVerifier
	opts     Options
	log      *slog.Logger
}

func NewHandler(hub *Hub, msg Messenger, p Presence, l Limiter, t TokenVerifier, opts Options, log *slog.Logger) *Handler {
	return &Handler{hub: hub, msg: msg, presence: p, limiter: l, tokens: t, opts: opts, log: log.With("component", "ws")}
}

// ServeHTTP upgrades GET /ws?access_token=<jwt>.
// Browsers cannot set Authorization headers on WebSocket, hence the query param.
// The access log MUST NOT print the query string (see httpapi.requestLogger).
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	userID, err := h.tokens.Verify(r.URL.Query().Get("access_token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized) // RS11: auth before upgrade
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.opts.AllowedOrigins})
	if err != nil {
		return
	}
	ws.SetReadLimit(h.opts.MaxMessageBytes)

	c := newConn(ws, userID, h.opts.SendBuffer)
	if err := h.hub.Register(c); err != nil {
		_ = ws.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer func() {
		cancel()
		h.hub.Unregister(c)
		uctx, ucancel := context.WithTimeout(context.Background(), time.Second)
		_ = h.presence.Unregister(uctx, userID, c.ID)
		ucancel()
		c.close(websocket.StatusNormalClosure, "")
	}()

	if err := h.presence.Register(ctx, userID, c.ID); err != nil {
		// Presence is advisory; delivery still works via Kafka broadcast (RS39).
		h.log.Warn("presence register failed", "err", err)
	}
	h.log.Debug("ws connected", "conn_id", c.ID, "user_id", userID)

	go c.writeLoop(ctx, h.opts.PingInterval, h.opts.PongTimeout, 5*time.Second, func() {
		_ = h.presence.Refresh(ctx, userID)
	})

	// Hint the client to run cursor sync right after (re)connect (RS15, RS4).
	c.Enqueue(encode(FrameResync, "", nil))

	h.readLoop(ctx, c)
}

func (h *Handler) readLoop(ctx context.Context, c *Conn) {
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return // closed, timeout or read limit exceeded
		}
		if typ != websocket.MessageText {
			continue
		}
		var f Frame
		if err := json.Unmarshal(data, &f); err != nil {
			c.Enqueue(encode(FrameError, "", ErrorPayload{Code: "bad_frame", Message: "invalid JSON"}))
			continue
		}
		h.dispatch(ctx, c, f)
	}
}

func (h *Handler) dispatch(ctx context.Context, c *Conn, f Frame) {
	switch f.Type {
	case FramePing:
		c.Enqueue(encode(FramePong, f.Ref, nil))

	case FrameSend:
		if !h.limiter.Allow(ctx, "ws_send", c.UserID.String()) {
			metrics.RateLimited.WithLabelValues("ws_send").Inc()
			c.Enqueue(encode(FrameError, f.Ref, ErrorPayload{Code: "rate_limited", Message: "slow down"}))
			return
		}
		var p SendPayload
		if err := json.Unmarshal(f.Payload, &p); err != nil {
			c.Enqueue(encode(FrameError, f.Ref, ErrorPayload{Code: "bad_payload", Message: "invalid send payload"}))
			return
		}
		res, err := h.msg.Send(ctx, domain.SendCommand{
			SenderID:        c.UserID, // from auth, never from client
			ClientMessageID: p.ClientMessageID,
			ConversationID:  p.ConversationID,
			Ciphertext:      p.Ciphertext,
			ProtocolMeta:    p.ProtocolMeta,
			ClientCreatedAt: p.ClientCreatedAt,
		})
		if err != nil {
			c.Enqueue(encode(FrameError, f.Ref, toErrorPayload(err)))
			if code := toErrorPayload(err).Code; code == "internal" {
				h.log.Error("send failed", "err", err, "conversation_id", p.ConversationID)
			}
			return
		}
		// Server-accepted ACK – only after PostgreSQL commit (RS6).
		c.Enqueue(encode(FrameAccepted, f.Ref, AcceptedPayload{
			ClientMessageID: res.Message.ClientMessageID,
			MessageID:       res.Message.ID,
			ConversationID:  res.Message.ConversationID,
			Seq:             res.Message.Seq,
			Duplicate:       res.Duplicate,
			State:           string(domain.StateAccepted),
		}))

	case FrameAck:
		var p AckPayload
		if err := json.Unmarshal(f.Payload, &p); err != nil {
			c.Enqueue(encode(FrameError, f.Ref, ErrorPayload{Code: "bad_payload", Message: "invalid ack payload"}))
			return
		}
		if err := h.msg.Acknowledge(ctx, c.UserID, p.MessageID, domain.DeliveryState(p.State)); err != nil {
			c.Enqueue(encode(FrameError, f.Ref, toErrorPayload(err)))
		}

	default:
		c.Enqueue(encode(FrameError, f.Ref, ErrorPayload{Code: "unknown_type", Message: f.Type}))
	}
}

func toErrorPayload(err error) ErrorPayload {
	switch {
	case errors.Is(err, domain.ErrNotMember):
		return ErrorPayload{Code: "forbidden", Message: "not a member"}
	case errors.Is(err, domain.ErrNotFound):
		return ErrorPayload{Code: "not_found", Message: "not found"}
	case errors.Is(err, domain.ErrInvalidInput):
		return ErrorPayload{Code: "invalid", Message: "invalid input"}
	default:
		// RS37: client does not know if it was stored → retry with SAME clientMessageId.
		return ErrorPayload{Code: "internal", Message: "retry with the same clientMessageId"}
	}
}
