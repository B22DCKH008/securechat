package delivery

import (
	"testing"

	"github.com/google/uuid"
)

func TestDedupe(t *testing.T) {
	d := NewDedupe(2)
	a, b, c := uuid.New(), uuid.New(), uuid.New()

	if !d.FirstSeen(a) || d.FirstSeen(a) {
		t.Fatal("a: expected first=true then duplicate=false")
	}
	d.FirstSeen(b)
	d.FirstSeen(c) // evicts a
	if !d.FirstSeen(a) {
		t.Fatal("a should have been evicted from bounded window")
	}
	if d.FirstSeen(c) {
		t.Fatal("c should still be remembered")
	}
}
