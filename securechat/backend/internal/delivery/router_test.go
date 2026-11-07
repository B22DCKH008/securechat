package delivery

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/events"
)

type fakePusher struct{ got map[uuid.UUID]int }

func (f *fakePusher) PushToUser(id uuid.UUID, _ []byte) int { f.got[id]++; return 1 }

func TestRouterPushesOnceDespiteDuplicateEvent(t *testing.T) {
	p := &fakePusher{got: map[uuid.UUID]int{}}
	r := NewRouter(p, 100)
	bob := uuid.New()
	env, _ := events.New(events.TypeMessageAccepted, events.MessageAccepted{
		MessageID: uuid.New(), Recipients: []uuid.UUID{bob}, AcceptedAt: time.Now(),
	}, time.Now())
	raw, _ := json.Marshal(env)

	for i := 0; i < 3; i++ { // at-least-once: same event delivered 3 times
		if err := r.Handle(raw); err != nil {
			t.Fatal(err)
		}
	}
	if p.got[bob] != 1 {
		t.Fatalf("bob pushed %d times, want 1", p.got[bob])
	}
}

func TestRouterPoisonIsPermanent(t *testing.T) {
	r := NewRouter(&fakePusher{got: map[uuid.UUID]int{}}, 10)
	err := r.Handle([]byte("not-json"))
	if _, ok := err.(PermanentError); !ok {
		t.Fatalf("expected PermanentError, got %v", err)
	}
}
