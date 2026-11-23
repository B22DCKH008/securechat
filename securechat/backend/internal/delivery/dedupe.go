package delivery

import (
	"sync"

	"github.com/google/uuid"
)

// Dedupe is a bounded, in-memory "seen eventId" set (KF5).
//
// It only suppresses duplicates seen by THIS instance recently (relay re-publish,
// rebalance replay). It is not a correctness guarantee: clients still dedupe by
// messageId/seq, and PostgreSQL unique constraints remain the source of truth.
type Dedupe struct {
	mu   sync.Mutex
	seen map[uuid.UUID]struct{}
	ring []uuid.UUID
	pos  int
}

func NewDedupe(capacity int) *Dedupe {
	if capacity <= 0 {
		capacity = 1
	}
	return &Dedupe{seen: make(map[uuid.UUID]struct{}, capacity), ring: make([]uuid.UUID, capacity)}
}

// FirstSeen returns true the first time id is observed; false for duplicates.
func (d *Dedupe) FirstSeen(id uuid.UUID) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[id]; ok {
		return false
	}
	d.addLocked(id)
	return true
}

// Seen reports whether id was already handled, without remembering it.
func (d *Dedupe) Seen(id uuid.UUID) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.seen[id]
	return ok
}

// Remember records id as handled. Call it only after the event was processed
// successfully, so a failed (poison/transient) event is never turned into a
// dedupe success when Kafka replays it.
func (d *Dedupe) Remember(id uuid.UUID) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[id]; !ok {
		d.addLocked(id)
	}
}

func (d *Dedupe) addLocked(id uuid.UUID) {
	if old := d.ring[d.pos]; old != uuid.Nil {
		delete(d.seen, old) // evict oldest (FIFO)
	}
	d.ring[d.pos] = id
	d.pos = (d.pos + 1) % len(d.ring)
	d.seen[id] = struct{}{}
}
