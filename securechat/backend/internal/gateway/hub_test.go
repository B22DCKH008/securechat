package gateway

import (
	"testing"

	"github.com/google/uuid"
)

func TestHubConnectionLimit(t *testing.T) {
	h := NewHub(2)
	uid := uuid.New()
	for i := 0; i < 2; i++ {
		if err := h.Register(&Conn{ID: uuid.NewString(), UserID: uid, send: make(chan []byte, 1), done: make(chan struct{})}); err != nil {
			t.Fatalf("register %d: %v", i, err)
		}
	}
	if err := h.Register(&Conn{UserID: uid, send: make(chan []byte, 1), done: make(chan struct{})}); err != ErrTooManyConnections {
		t.Fatalf("expected ErrTooManyConnections, got %v", err)
	}
}

func TestPushOnlyToTargetUser(t *testing.T) {
	h := NewHub(0)
	alice, bob := uuid.New(), uuid.New()
	ca := &Conn{UserID: alice, send: make(chan []byte, 4), done: make(chan struct{})}
	cb := &Conn{UserID: bob, send: make(chan []byte, 4), done: make(chan struct{})}
	_ = h.Register(ca)
	_ = h.Register(cb)

	if n := h.PushToUser(bob, []byte("x")); n != 1 {
		t.Fatalf("pushed to %d conns, want 1", n)
	}
	if len(ca.send) != 0 || len(cb.send) != 1 {
		t.Fatalf("wrong routing: alice=%d bob=%d", len(ca.send), len(cb.send))
	}
	if h.PushToUser(uuid.New(), []byte("x")) != 0 {
		t.Fatal("unknown user should receive nothing")
	}
}
