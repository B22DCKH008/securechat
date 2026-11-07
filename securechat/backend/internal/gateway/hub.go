// Package gateway is the WebSocket edge: connection lifecycle, heartbeat,
// per-instance local routing and backpressure (RS11-RS20).
package gateway

import (
	"errors"
	"sync"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/metrics"
)

var ErrTooManyConnections = errors.New("too many connections for user")

// Hub tracks connections LOCAL to this instance. Cross-instance delivery is done
// by every instance consuming Kafka and pushing only to its own Hub (RS13, KF7).
type Hub struct {
	mu         sync.RWMutex
	users      map[uuid.UUID]map[*Conn]struct{}
	maxPerUser int
}

func NewHub(maxPerUser int) *Hub {
	return &Hub{users: make(map[uuid.UUID]map[*Conn]struct{}), maxPerUser: maxPerUser}
}

func (h *Hub) Register(c *Conn) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.users[c.UserID]
	if h.maxPerUser > 0 && len(set) >= h.maxPerUser {
		return ErrTooManyConnections // RS19 connection limit
	}
	if set == nil {
		set = make(map[*Conn]struct{})
		h.users[c.UserID] = set
	}
	set[c] = struct{}{}
	metrics.WSConnections.Inc()
	return nil
}

func (h *Hub) Unregister(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.users[c.UserID]; ok {
		if _, ok := set[c]; ok {
			delete(set, c)
			metrics.WSConnections.Dec()
		}
		if len(set) == 0 {
			delete(h.users, c.UserID)
		}
	}
}

// PushToUser enqueues frame on every local connection of userID (multi-tab /
// multi-device on the same instance). Returns how many connections accepted it.
// Never blocks: slow connections are closed and must resync (RS17, RS18).
func (h *Hub) PushToUser(userID uuid.UUID, frame []byte) int {
	h.mu.RLock()
	conns := make([]*Conn, 0, len(h.users[userID]))
	for c := range h.users[userID] {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	n := 0
	for _, c := range conns {
		if c.Enqueue(frame) {
			n++
		}
	}
	return n
}

func (h *Hub) HasLocal(userID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.users[userID]) > 0
}

// CloseAll is used on graceful shutdown so clients reconnect elsewhere (RS29).
func (h *Hub) CloseAll(reason string) {
	h.mu.RLock()
	var all []*Conn
	for _, set := range h.users {
		for c := range set {
			all = append(all, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range all {
		c.CloseGoingAway(reason)
	}
}
