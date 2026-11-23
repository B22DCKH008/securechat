//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/securechat/backend/internal/delivery"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/events"
	"github.com/securechat/backend/internal/gateway"
	kafkaplatform "github.com/securechat/backend/internal/platform/kafka"
)

func copiesFor(ids ...uuid.UUID) []domain.RecipientCiphertext {
	out := make([]domain.RecipientCiphertext, 0, len(ids))
	for _, id := range ids {
		out = append(out, domain.RecipientCiphertext{RecipientID: id, DeviceID: 1, Ciphertext: []byte("for-" + id.String()[:8]), ProtocolMeta: json.RawMessage(`{"type":3}`)})
	}
	return out
}

func groupSend(sender, conv uuid.UUID, id string, copies []domain.RecipientCiphertext) domain.SendCommand {
	return domain.SendCommand{SenderID: sender, ConversationID: conv, ClientMessageID: id, Ciphertexts: copies}
}

func lastOutbox(t *testing.T, f *fixture) events.MessageAccepted {
	t.Helper()
	var raw []byte
	if err := f.pool.QueryRow(ctx, `SELECT payload FROM outbox WHERE topic='chat.messages' ORDER BY id DESC LIMIT 1`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var env events.Envelope
	var p events.MessageAccepted
	if json.Unmarshal(raw, &env) != nil || json.Unmarshal(env.Payload, &p) != nil {
		t.Fatal("bad outbox payload")
	}
	return p
}

func sameSet(a, b []uuid.UUID) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	cmp := func(x, y uuid.UUID) int { return slices.Compare(x[:], y[:]) }
	slices.SortFunc(a, cmp)
	slices.SortFunc(b, cmp)
	return slices.Equal(a, b)
}

func TestGroupLifecycleVisibilityAndFanoutContract(t *testing.T) {
	f := newFixture(t)
	a, b, c := f.a, f.b, f.c
	d := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id,username) VALUES ($1,'user3')`, d); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateGroup(ctx, a, " ", []uuid.UUID{b}); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("blank title accepted")
	}
	if _, err := f.svc.CreateGroup(ctx, a, "x", []uuid.UUID{uuid.New()}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("unknown member accepted")
	}
	g, err := f.svc.CreateGroup(ctx, a, "Nhóm đồ án", []uuid.UUID{b, c, b, a})
	if err != nil || g.Kind != domain.KindGroup || g.LastSeq != 1 || len(g.Members) != 3 {
		t.Fatalf("create group: %+v %v", g, err)
	}
	if ev := lastOutbox(t, f); ev.Kind != domain.MessageKindSystem || ev.System.Type != domain.SystemGroupCreated || !sameSet(ev.Recipients, []uuid.UUID{b, c}) {
		t.Fatalf("group_created event: %+v", ev)
	}

	// Pairwise send: exactly one copy per other member.
	res, err := f.svc.Send(ctx, groupSend(a, g.ID, "g-1", copiesFor(b, c)))
	if err != nil || res.Message.Seq != 2 {
		t.Fatalf("group send: %v", err)
	}
	ev := lastOutbox(t, f)
	if len(ev.Ciphertext) != 0 || len(ev.Ciphertexts) != 2 || !sameSet(ev.Recipients, []uuid.UUID{b, c}) {
		t.Fatal("group event must carry per-recipient copies only")
	}
	before := number(t, f.pool, `SELECT count(*) FROM messages`)
	for name, cmd := range map[string]domain.SendCommand{
		"missing member": groupSend(a, g.ID, "g-x1", copiesFor(b)),
		"non-member":     groupSend(a, g.ID, "g-x2", copiesFor(b, c, d)),
	} {
		if _, err := f.svc.Send(ctx, cmd); !errors.Is(err, domain.ErrMembershipChanged) {
			t.Fatalf("%s: got %v", name, err)
		}
	}
	single := groupSend(a, g.ID, "g-x3", nil)
	single.Ciphertext = []byte{1}
	if _, err := f.svc.Send(ctx, single); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("single ciphertext accepted for group")
	}
	if _, err := f.svc.Send(ctx, groupSend(a, f.conv, "d-x", copiesFor(b))); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("ciphertexts accepted for direct conversation")
	}
	if number(t, f.pool, `SELECT count(*) FROM messages`) != before || number(t, f.pool, `SELECT last_seq FROM conversations WHERE id=$1`, g.ID) != 2 {
		t.Fatal("rejected sends left rows or consumed seq")
	}

	// Idempotent retry (copies compared too, JSONB-equal metadata).
	retry := groupSend(a, g.ID, "g-1", copiesFor(c, b))
	retry.Ciphertexts[0].ProtocolMeta = json.RawMessage(`{ "type" : 3 }`)
	if dup, err := f.svc.Send(ctx, retry); err != nil || !dup.Duplicate || dup.Message.ID != res.Message.ID {
		t.Fatalf("retry: %v", err)
	}
	changed := groupSend(a, g.ID, "g-1", copiesFor(b, c))
	changed.Ciphertexts[1].Ciphertext = []byte("other")
	if _, err := f.svc.Send(ctx, changed); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("changed copy on retry not a conflict")
	}

	// Each reader gets its own copy; the sender has none.
	for user, want := range map[uuid.UUID]string{b: "for-" + b.String()[:8], c: "for-" + c.String()[:8], a: ""} {
		msgs, err := f.svc.History(ctx, user, g.ID, 0, 50)
		if err != nil || len(msgs) != 2 || msgs[0].Seq != 2 || string(msgs[0].Ciphertext) != want || msgs[1].Kind != domain.MessageKindSystem {
			t.Fatalf("history view: %v", err)
		}
	}

	// Membership: owner only; new member sees from its join message on.
	if _, err := f.svc.AddMembers(ctx, b, g.ID, []uuid.UUID{d}); !errors.Is(err, domain.ErrNotMember) {
		t.Fatal("non-owner added a member")
	}
	members, err := f.svc.AddMembers(ctx, a, g.ID, []uuid.UUID{d, b})
	if err != nil || len(members) != 4 {
		t.Fatalf("add: %v", err)
	}
	if ev := lastOutbox(t, f); ev.System.Type != domain.SystemMembersAdded || !slices.Equal(ev.System.UserIDs, []uuid.UUID{d}) || !sameSet(ev.Recipients, []uuid.UUID{b, c, d}) {
		t.Fatal("members_added event")
	}
	if _, err := f.svc.AddMembers(ctx, a, g.ID, []uuid.UUID{d}); err != nil || number(t, f.pool, `SELECT last_seq FROM conversations WHERE id=$1`, g.ID) != 3 {
		t.Fatal("re-adding an existing member must be a no-op")
	}
	dHistory, err := f.svc.History(ctx, d, g.ID, 0, 50)
	if err != nil || len(dHistory) != 1 || dHistory[0].Seq != 3 {
		t.Fatalf("late member sees pre-join history: %v", err)
	}
	page, err := f.svc.Sync(ctx, d, map[uuid.UUID]int64{g.ID: 0}, 50)
	if err != nil || len(page) != 1 || len(page[0].Messages) != 1 || page[0].Messages[0].Seq != 3 {
		t.Fatal("late member sync")
	}
	if err := f.svc.Acknowledge(ctx, d, res.Message.ID, domain.StateRead); !errors.Is(err, domain.ErrNotMember) {
		t.Fatal("late member acknowledged a pre-join message")
	}
	if err := f.svc.Acknowledge(ctx, b, res.Message.ID, domain.StateRead); err != nil {
		t.Fatal(err)
	}
	for user, want := range map[uuid.UUID]int{c: 1, d: 0} {
		page, err := f.svc.Sync(ctx, user, map[uuid.UUID]int64{g.ID: 3}, 50)
		if err != nil {
			t.Fatal(err)
		}
		got := 0
		for _, p := range page {
			got += len(p.Receipts)
		}
		if got != want {
			t.Fatalf("receipt visibility: got %d want %d", got, want)
		}
	}
	if _, err := f.svc.Send(ctx, groupSend(a, g.ID, "g-2", copiesFor(b, c))); !errors.Is(err, domain.ErrMembershipChanged) {
		t.Fatal("send ignored the new member")
	}
	if _, err := f.svc.Send(ctx, groupSend(b, g.ID, "g-2", copiesFor(a, c, d))); err != nil {
		t.Fatal(err)
	}

	// Removal: removed user is notified, loses access, sync reports departure.
	if err := f.svc.RemoveMember(ctx, b, g.ID, d); !errors.Is(err, domain.ErrNotMember) {
		t.Fatal("non-owner removed a member")
	}
	if err := f.svc.RemoveMember(ctx, a, g.ID, c); err != nil {
		t.Fatal(err)
	}
	if ev := lastOutbox(t, f); ev.System.Type != domain.SystemMemberRemoved || !sameSet(ev.Recipients, []uuid.UUID{b, c, d}) {
		t.Fatal("member_removed must also reach the removed user")
	}
	if _, err := f.svc.History(ctx, c, g.ID, 0, 50); !errors.Is(err, domain.ErrNotMember) {
		t.Fatal("removed member still reads history")
	}
	_, left, err := f.svc.SyncFull(ctx, c, map[uuid.UUID]int64{g.ID: 4}, nil, 50)
	if err != nil || len(left) != 1 || left[0].ConversationID != g.ID || left[0].LeftSeq != 5 {
		t.Fatalf("departure not reported: %v %+v", err, left)
	}
	if _, err := f.svc.Send(ctx, groupSend(c, g.ID, "c-x", copiesFor(a, b, d))); !errors.Is(err, domain.ErrNotMember) {
		t.Fatal("removed member sent")
	}

	// Leaving; owner leaving promotes the earliest remaining member.
	if err := f.svc.RemoveMember(ctx, b, g.ID, b); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.RemoveMember(ctx, a, g.ID, a); err != nil {
		t.Fatal(err)
	}
	if ev := lastOutbox(t, f); ev.System.Type != domain.SystemMemberLeft || ev.System.NewOwner == nil || *ev.System.NewOwner != d {
		t.Fatal("owner promotion")
	}
	if err := f.svc.RenameGroup(ctx, d, g.ID, "Mới"); err != nil {
		t.Fatal(err)
	}
	// Last member leaving writes the system message but emits no recipientless event.
	outboxBefore := number(t, f.pool, `SELECT count(*) FROM outbox`)
	if err := f.svc.RemoveMember(ctx, d, g.ID, d); err != nil {
		t.Fatal(err)
	}
	if number(t, f.pool, `SELECT count(*) FROM outbox`) != outboxBefore {
		t.Fatal("recipientless event emitted")
	}
	// Seq is gapless across user and system messages.
	if number(t, f.pool, `SELECT count(*) FROM messages WHERE conversation_id=$1`, g.ID) != number(t, f.pool, `SELECT max(seq) FROM messages WHERE conversation_id=$1`, g.ID) {
		t.Fatal("seq gap")
	}

	// Direct conversations reject group operations.
	if _, err := f.svc.AddMembers(ctx, a, f.conv, []uuid.UUID{c}); !errors.Is(err, domain.ErrNotMember) {
		t.Fatal("direct add")
	}
	if err := f.svc.RemoveMember(ctx, a, f.conv, a); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatal("direct leave")
	}
}

func TestGroupConcurrentSendAndMembershipChange(t *testing.T) {
	f := newFixture(t)
	d := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO users (id,username) VALUES ($1,'user3')`, d); err != nil {
		t.Fatal(err)
	}
	g, err := f.svc.CreateGroup(ctx, f.a, "race", []uuid.UUID{f.b, f.c})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := range 20 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, err := f.svc.Send(ctx, groupSend(f.b, g.ID, fmt.Sprint("b-", i), copiesFor(f.a, f.c)))
			if errors.Is(err, domain.ErrMembershipChanged) {
				err = nil // allowed once d joined
			}
			errs <- err
		}()
		go func() {
			defer wg.Done()
			var err error
			if i%2 == 0 {
				_, err = f.svc.AddMembers(ctx, f.a, g.ID, []uuid.UUID{d})
			} else {
				err = f.svc.RemoveMember(ctx, f.a, g.ID, d)
				if errors.Is(err, domain.ErrNotFound) {
					err = nil
				}
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// Every accepted message's copies match the member set at its seq.
	rows, err := f.pool.Query(ctx, `SELECT m.seq, count(r.recipient_id) FROM messages m
		LEFT JOIN message_recipients r ON r.message_id=m.id WHERE m.conversation_id=$1 AND m.kind='message'
		GROUP BY m.seq ORDER BY m.seq`, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var seq, n int64
		if err := rows.Scan(&seq, &n); err != nil {
			t.Fatal(err)
		}
		if n != 2 {
			t.Fatalf("message seq %d has %d copies", seq, n)
		}
	}
	if number(t, f.pool, `SELECT count(*) FROM messages WHERE conversation_id=$1`, g.ID) != number(t, f.pool, `SELECT max(seq) FROM messages WHERE conversation_id=$1`, g.ID) {
		t.Fatal("seq gap under concurrency")
	}
}

func TestGroupFanoutAcrossInstancesOverKafka(t *testing.T) {
	f := newFixture(t)
	sa, _, ha := server(t, f)
	sb, _, hb := server(t, f)
	alice := register(t, sa, "grp_alice")
	bob := register(t, sb, "grp_bob")
	carol := register(t, sa, "grp_carol")

	brokers := []string{env("TEST_KAFKA_BROKERS", "localhost:9094")}
	producer, err := kafkaplatform.NewProducer(brokers, "group-test-producer")
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	consumerCtx, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	for i, hub := range []*gateway.Hub{ha, hb} {
		consumer, err := kafkaplatform.NewGatewayConsumer(brokers, "grp-"+f.schema+fmt.Sprint(i), false, false, "chat.messages", "chat.receipts")
		if err != nil {
			t.Fatal(err)
		}
		defer consumer.Close()
		kc := delivery.NewKafkaConsumer(consumer, producer, delivery.NewRouter(hub, 10000), "chat.dlq", quiet)
		wg.Add(1)
		go func() { defer wg.Done(); kc.Run(consumerCtx) }()
	}
	defer func() { stop(); wg.Wait() }()

	dial := func(base, token string) (*websocket.Conn, <-chan gateway.Frame, context.CancelFunc) {
		ws, _, err := websocket.Dial(ctx, "ws"+base[4:]+"/ws?access_token="+token, nil)
		if err != nil {
			t.Fatal(err)
		}
		op, cancel := context.WithTimeout(ctx, 40*time.Second)
		return ws, readFrames(op, ws), cancel
	}
	aliceWS, aliceFrames, c1 := dial(sa.URL, alice.AccessToken)
	defer func() { c1(); aliceWS.CloseNow() }()
	bobWS, bobFrames, c2 := dial(sb.URL, bob.AccessToken)
	defer func() { c2(); bobWS.CloseNow() }()
	carolWS, carolFrames, c3 := dial(sa.URL, carol.AccessToken)
	defer func() { c3(); carolWS.CloseNow() }()
	op, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	for _, frames := range []<-chan gateway.Frame{aliceFrames, bobFrames, carolFrames} {
		awaitFrame(t, op, frames, gateway.FrameResync)
	}
	relayCancel, done := startRelay(t, f, producer)
	defer func() { relayCancel(); <-done }()

	var g domain.Conversation
	raw := request(t, sa.URL, "POST", "/v1/conversations/group", alice.AccessToken, map[string]any{"title": "Team", "memberUserIds": []uuid.UUID{bob.UserID, carol.UserID}}, 201)
	if err := json.Unmarshal(raw, &g); err != nil || g.Kind != "group" {
		t.Fatal("create group over HTTP")
	}
	for _, frames := range []<-chan gateway.Frame{bobFrames, carolFrames} {
		var p events.MessageAccepted
		if json.Unmarshal(awaitFrame(t, op, frames, gateway.FrameMessage).Payload, &p) != nil || p.Kind != "system" || p.System.Type != domain.SystemGroupCreated {
			t.Fatal("group_created not pushed")
		}
	}
	var listed struct{ Members []domain.Member }
	_ = json.Unmarshal(request(t, sb.URL, "GET", "/v1/conversations/"+g.ID.String()+"/members", bob.AccessToken, nil, 200), &listed)
	if len(listed.Members) != 3 {
		t.Fatal("members endpoint")
	}

	// Alice sends over WebSocket with one pairwise copy per member.
	copies := copiesFor(bob.UserID, carol.UserID)
	frame, _ := json.Marshal(map[string]any{"type": "send", "ref": "r1", "payload": map[string]any{
		"clientMessageId": "ws-group-1", "conversationId": g.ID, "ciphertexts": copies, "protocolMeta": map[string]any{}}})
	if err := aliceWS.Write(op, websocket.MessageText, frame); err != nil {
		t.Fatal(err)
	}
	var acc gateway.AcceptedPayload
	if json.Unmarshal(awaitFrame(t, op, aliceFrames, gateway.FrameAccepted).Payload, &acc) != nil || acc.Seq != 2 {
		t.Fatal("accepted")
	}
	for frames, want := range map[<-chan gateway.Frame]string{bobFrames: string(copies[0].Ciphertext), carolFrames: string(copies[1].Ciphertext)} {
		var p events.MessageAccepted
		if json.Unmarshal(awaitFrame(t, op, frames, gateway.FrameMessage).Payload, &p) != nil || string(p.Ciphertext) != want || len(p.Ciphertexts) != 0 || p.MessageID != acc.MessageID {
			t.Fatal("recipient did not get exactly its own copy")
		}
	}
	// Stale member list → membership_changed error frame, nothing stored.
	stale, _ := json.Marshal(map[string]any{"type": "send", "ref": "r2", "payload": map[string]any{
		"clientMessageId": "ws-group-2", "conversationId": g.ID, "ciphertexts": copiesFor(bob.UserID), "protocolMeta": map[string]any{}}})
	if err := aliceWS.Write(op, websocket.MessageText, stale); err != nil {
		t.Fatal(err)
	}
	var e gateway.ErrorPayload
	if json.Unmarshal(awaitFrame(t, op, aliceFrames, gateway.FrameError).Payload, &e) != nil || e.Code != "membership_changed" {
		t.Fatalf("stale send: %+v", e)
	}

	// Removal over HTTP: carol is told, then sync reports the departure.
	request(t, sa.URL, "DELETE", "/v1/conversations/"+g.ID.String()+"/members/"+carol.UserID.String(), alice.AccessToken, nil, 204)
	var removed events.MessageAccepted
	if json.Unmarshal(awaitFrame(t, op, carolFrames, gateway.FrameMessage).Payload, &removed) != nil || removed.System == nil || removed.System.Type != domain.SystemMemberRemoved {
		t.Fatal("removed member not notified")
	}
	var syncRes struct {
		Left []domain.Departure `json:"left"`
	}
	_ = json.Unmarshal(request(t, sa.URL, "POST", "/v1/sync", carol.AccessToken, map[string]any{"cursors": map[string]int64{g.ID.String(): 2}}, 200), &syncRes)
	if len(syncRes.Left) != 1 || syncRes.Left[0].ConversationID != g.ID {
		t.Fatal("sync did not report departure")
	}
	request(t, sa.URL, "GET", "/v1/conversations/"+g.ID.String()+"/messages", carol.AccessToken, nil, 403)
	request(t, sb.URL, "DELETE", "/v1/conversations/"+g.ID.String()+"/members/"+alice.UserID.String(), bob.AccessToken, nil, 403)
	request(t, sb.URL, "PATCH", "/v1/conversations/"+g.ID.String(), bob.AccessToken, map[string]string{"title": "x"}, 403)
	request(t, sa.URL, "PATCH", "/v1/conversations/"+g.ID.String(), alice.AccessToken, map[string]string{"title": "Team 2"}, 204)
}
