package gateway

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/securechat/backend/internal/metrics"
)

// Conn is one WebSocket connection with a bounded outbound queue.
type Conn struct {
	ID     string
	UserID uuid.UUID

	ws        *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
	done      chan struct{}
}

func newConn(ws *websocket.Conn, userID uuid.UUID, buf int) *Conn {
	return &Conn{
		ID:     uuid.NewString(),
		UserID: userID,
		ws:     ws,
		send:   make(chan []byte, buf),
		done:   make(chan struct{}),
	}
}

// Enqueue never blocks. A full buffer means the client is too slow: close it so
// memory stays bounded; the client reconnects and syncs from PostgreSQL.
func (c *Conn) Enqueue(frame []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.send <- frame:
		return true
	default:
		metrics.WSSlowConsumerDrops.Inc()
		c.close(websocket.StatusPolicyViolation, "slow consumer; resync required")
		return false
	}
}

func (c *Conn) CloseGoingAway(reason string) { c.close(websocket.StatusGoingAway, reason) }

func (c *Conn) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		close(c.done)
		go func() { _ = c.ws.Close(code, reason) }() // Close waits for handshake; never block callers
	})
}

// writeLoop drains the send queue and sends heartbeats (RS14, RS20).
func (c *Conn) writeLoop(ctx context.Context, pingEvery, pongTimeout, writeTimeout time.Duration, onHeartbeat func()) {
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		case frame := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(wctx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				c.close(websocket.StatusAbnormalClosure, "write failed")
				return
			}
			metrics.WSPushed.Inc()
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(ctx, pongTimeout)
			err := c.ws.Ping(pctx) // requires the concurrent read loop to receive the pong
			cancel()
			if err != nil {
				c.close(websocket.StatusPolicyViolation, "heartbeat timeout") // dead connection (RS20)
				return
			}
			onHeartbeat()
		}
	}
}
