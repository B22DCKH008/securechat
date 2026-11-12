//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/delivery"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/events"
	"github.com/securechat/backend/internal/gateway"
	"github.com/securechat/backend/internal/httpapi"
	"github.com/securechat/backend/internal/outbox"
	kafkaplatform "github.com/securechat/backend/internal/platform/kafka"
	"github.com/securechat/backend/internal/service/keys"
	"github.com/securechat/backend/internal/service/messaging"
	"github.com/twmb/franz-go/pkg/kgo"
)

var ctx = context.Background()
var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

const secret = "integration-only-secret-01234567890123456789"

type fixture struct {
	pool    *pgxpool.Pool
	schema  string
	a, b, c uuid.UUID
	conv    uuid.UUID
	svc     *messaging.Service
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func database(t *testing.T, through int) (*pgxpool.Pool, string) {
	t.Helper()
	dsn := env("TEST_POSTGRES_DSN", "postgres://securechat:securechat@localhost:5432/securechat?sslmode=disable")
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("PostgreSQL required (TEST_POSTGRES_DSN): %v", err)
	}
	schema := "be1_" + uuid.New().String()[:8]
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 8
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close(); _, _ = admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`); _ = admin.Close(ctx) })
	files, err := filepath.Glob("../../migrations/*.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for i, file := range files {
		if through > 0 && i >= through {
			break
		}
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(data)); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}
	return pool, schema
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool, schema := database(t, 0)
	f := &fixture{pool: pool, schema: schema}
	f.a, f.b, f.c = uuid.New(), uuid.New(), uuid.New()
	for i, id := range []uuid.UUID{f.a, f.b, f.c} {
		if _, err := pool.Exec(ctx, `INSERT INTO users (id,username) VALUES ($1,$2)`, id, fmt.Sprint("user", i)); err != nil {
			t.Fatal(err)
		}
	}
	f.svc = messaging.New(pool, messaging.Topics{Messages: "chat.messages", Receipts: "chat.receipts"}, 65536)
	conv, err := f.svc.CreateDirect(ctx, f.a, f.b)
	if err != nil {
		t.Fatal(err)
	}
	f.conv = conv.ID
	return f
}
func (f *fixture) command(id string) domain.SendCommand {
	return domain.SendCommand{SenderID: f.a, ConversationID: f.conv, ClientMessageID: id, Ciphertext: []byte{1, 2, 3, 4}, ProtocolMeta: json.RawMessage(`{"type":3,"deviceId":1}`)}
}
func number(t *testing.T, pool *pgxpool.Pool, q string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func eventually(t *testing.T, timeout time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not reached before deadline")
}

func TestIdempotentRetryCreatesOneMessage(t *testing.T) {
	f := newFixture(t)
	cmd := f.command("retry")
	var wg sync.WaitGroup
	results := make(chan domain.SendResult, 12)
	errs := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() { defer wg.Done(); r, e := f.svc.Send(ctx, cmd); results <- r; errs <- e }()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var id uuid.UUID
	for r := range results {
		if id == uuid.Nil {
			id = r.Message.ID
		}
		if r.Message.ID != id || r.Message.Seq != 1 {
			t.Fatal("retry changed identity or seq")
		}
	}
	if number(t, f.pool, `SELECT count(*) FROM messages`) != 1 || number(t, f.pool, `SELECT count(*) FROM outbox`) != 1 {
		t.Fatal("duplicate persistence")
	}
	reordered := cmd
	reordered.ProtocolMeta = json.RawMessage(`{"deviceId":1,"type":3}`)
	if _, e := f.svc.Send(ctx, reordered); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*domain.SendCommand){func(c *domain.SendCommand) { c.Ciphertext = []byte("changed") }, func(c *domain.SendCommand) { c.ProtocolMeta = json.RawMessage(`{"type":2}`) }, func(c *domain.SendCommand) { now := time.Now(); c.ClientCreatedAt = &now }} {
		changed := cmd
		mutate(&changed)
		if _, e := f.svc.Send(ctx, changed); !errors.Is(e, domain.ErrConflict) {
			t.Fatalf("expected conflict, got %v", e)
		}
	}
}
func TestSeqIsGaplessUnderConcurrentWriters(t *testing.T) {
	f := newFixture(t)
	other := messaging.New(f.pool, messaging.Topics{Messages: "chat.messages", Receipts: "chat.receipts"}, 65536)
	errs := make(chan error, 32)
	for i := range 32 {
		go func(i int) {
			s := f.svc
			if i%2 == 0 {
				s = other
			}
			_, e := s.Send(ctx, f.command(fmt.Sprint(i)))
			errs <- e
		}(i)
	}
	for range 32 {
		if e := <-errs; e != nil {
			t.Fatal(e)
		}
	}
	if n := number(t, f.pool, `SELECT count(DISTINCT seq) FROM messages WHERE seq BETWEEN 1 AND 32`); n != 32 {
		t.Fatalf("unique contiguous seqs: %d", n)
	}
	if number(t, f.pool, `SELECT last_seq FROM conversations WHERE id=$1`, f.conv) != 32 {
		t.Fatal("counter mismatch")
	}
}
func TestSendAndReceiptRollback(t *testing.T) {
	f := newFixture(t)
	// A deferred trigger fails at COMMIT, after all inserts and seq allocation.
	_, err := f.pool.Exec(ctx, `CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; RETURN NEW; END $$;
 CREATE CONSTRAINT TRIGGER reject_outbox AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_outbox();`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Send(ctx, f.command("atomic")); err == nil {
		t.Fatal("accepted failed commit")
	}
	if number(t, f.pool, `SELECT count(*) FROM messages`)+number(t, f.pool, `SELECT count(*) FROM outbox`)+number(t, f.pool, `SELECT last_seq FROM conversations WHERE id=$1`, f.conv) != 0 {
		t.Fatal("send rollback incomplete")
	}
	if _, err = f.pool.Exec(ctx, `DROP TRIGGER reject_outbox ON outbox`); err != nil {
		t.Fatal(err)
	}
	message, err := f.svc.Send(ctx, f.command("atomic"))
	if err != nil || message.Message.Seq != 1 {
		t.Fatalf("retry after rollback: %v", err)
	}
	if _, err = f.pool.Exec(ctx, `CREATE CONSTRAINT TRIGGER reject_outbox AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_outbox()`); err != nil {
		t.Fatal(err)
	}
	if err = f.svc.Acknowledge(ctx, f.b, message.Message.ID, domain.StateRead); err == nil {
		t.Fatal("receipt accepted failed commit")
	}
	if number(t, f.pool, `SELECT count(*) FROM message_receipts`)+number(t, f.pool, `SELECT count(*) FROM receipt_changes`)+number(t, f.pool, `SELECT last_receipt_seq FROM conversations WHERE id=$1`, f.conv) != 0 {
		t.Fatal("receipt rollback incomplete")
	}
}
func TestOfflineRecipientSyncsAfterReconnect(t *testing.T) {
	f := newFixture(t)
	for i := range 17 {
		if _, e := f.svc.Send(ctx, f.command(fmt.Sprint(i))); e != nil {
			t.Fatal(e)
		}
	}
	cursor := int64(0)
	seen := map[uuid.UUID]bool{}
	for {
		page, e := f.svc.Sync(ctx, f.b, map[uuid.UUID]int64{f.conv: cursor}, 5)
		if e != nil {
			t.Fatal(e)
		}
		if len(page) == 0 {
			break
		}
		for _, m := range page[0].Messages {
			if seen[m.ID] || m.Seq != cursor+1 {
				t.Fatal("sync gap/duplicate")
			}
			seen[m.ID] = true
			cursor = m.Seq
		}
		if !page[0].HasMore {
			break
		}
	}
	if len(seen) != 17 {
		t.Fatal("missing offline messages")
	}
	before := int64(0)
	count := 0
	for {
		page, e := f.svc.History(ctx, f.b, f.conv, before, 4)
		if e != nil {
			t.Fatal(e)
		}
		if len(page) == 0 {
			break
		}
		for _, m := range page {
			if before != 0 && m.Seq >= before {
				t.Fatal("history cursor repeated")
			}
			before = m.Seq
			count++
		}
	}
	if count != 17 {
		t.Fatal("history missing messages")
	}
}
func TestReceiptsMonotonicAndLateSync(t *testing.T) {
	f := newFixture(t)
	m, e := f.svc.Send(ctx, f.command("one"))
	if e != nil {
		t.Fatal(e)
	}
	errorsCh := make(chan error, 16)
	for i := range 16 {
		go func(i int) {
			state := domain.StateDelivered
			if i%2 == 0 {
				state = domain.StateRead
			}
			errorsCh <- f.svc.Acknowledge(ctx, f.b, m.Message.ID, state)
		}(i)
	}
	for range 16 {
		if e := <-errorsCh; e != nil {
			t.Fatal(e)
		}
	}
	if number(t, f.pool, `SELECT count(*) FROM message_receipts WHERE read_at IS NOT NULL AND delivered_at IS NOT NULL`) != 1 {
		t.Fatal("read must imply delivered")
	}
	if n := number(t, f.pool, `SELECT count(*) FROM receipt_changes`); n < 1 || n > 2 {
		t.Fatalf("non-idempotent receipts: %d", n)
	}
	page, e := f.svc.SyncWithReceipts(ctx, f.a, map[uuid.UUID]int64{f.conv: 1}, nil, 50)
	if e != nil || len(page) != 1 || len(page[0].Messages) != 0 || len(page[0].Receipts) == 0 {
		t.Fatalf("late receipt missing: %v", e)
	}
	receiptCursor := page[0].NextReceiptCursor
	page, e = f.svc.SyncWithReceipts(ctx, f.a, map[uuid.UUID]int64{f.conv: 1}, map[uuid.UUID]int64{f.conv: receiptCursor}, 50)
	if e != nil || len(page) != 0 {
		t.Fatal("checkpoint repeats receipts")
	}
}
func TestNonMemberCannotReadOrSend(t *testing.T) {
	f := newFixture(t)
	m, e := f.svc.Send(ctx, f.command("member"))
	if e != nil {
		t.Fatal(e)
	}
	cmd := f.command("intruder")
	cmd.SenderID = f.c
	_, e = f.svc.Send(ctx, cmd)
	if !errors.Is(e, domain.ErrNotMember) {
		t.Fatal("unauthorized send")
	}
	_, e = f.svc.History(ctx, f.c, f.conv, 0, 50)
	if !errors.Is(e, domain.ErrNotMember) {
		t.Fatal("unauthorized history")
	}
	_, e = f.svc.Sync(ctx, f.c, map[uuid.UUID]int64{f.conv: 0}, 50)
	if !errors.Is(e, domain.ErrNotMember) {
		t.Fatal("unauthorized sync")
	}
	for _, actor := range []uuid.UUID{f.a, f.c} {
		if e = f.svc.Acknowledge(ctx, actor, m.Message.ID, domain.StateRead); !errors.Is(e, domain.ErrNotMember) {
			t.Fatal("non-recipient acknowledged")
		}
	}
}
func TestReceiptMigrationBackfillsExistingState(t *testing.T) {
	pool, _ := database(t, 2)
	a, b, conv, msg := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{a, b} {
		if _, e := pool.Exec(ctx, `INSERT INTO users(id,username)VALUES($1,$2)`, id, id.String()); e != nil {
			t.Fatal(e)
		}
	}
	_, e := pool.Exec(ctx, `INSERT INTO conversations(id,last_seq)VALUES($1,1)`, conv)
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, `INSERT INTO messages(id,conversation_id,seq,sender_id,client_message_id,ciphertext)VALUES($1,$2,1,$3,'legacy',$4)`, msg, conv, a, []byte{1})
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, `INSERT INTO message_receipts(message_id,user_id,delivered_at,read_at)VALUES($1,$2,now(),now())`, msg, b)
	if e != nil {
		t.Fatal(e)
	}
	migration, e := os.ReadFile("../../migrations/000003_receipt_sync.up.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, string(migration)); e != nil {
		t.Fatal(e)
	}
	if number(t, pool, `SELECT last_receipt_seq FROM conversations WHERE id=$1`, conv) != 1 || number(t, pool, `SELECT count(*) FROM receipt_changes WHERE state='read'`) != 1 || number(t, pool, `SELECT count(*) FROM outbox`) != 0 {
		t.Fatal("invalid backfill")
	}
}

type allowAll struct{}

func (allowAll) Allow(context.Context, string, string) bool { return true }

type noPresence struct{}

func (noPresence) Register(context.Context, uuid.UUID, string) error   { return nil }
func (noPresence) Refresh(context.Context, uuid.UUID) error            { return nil }
func (noPresence) Unregister(context.Context, uuid.UUID, string) error { return nil }
func server(t *testing.T, f *fixture) (*httptest.Server, *auth.Service, *gateway.Hub) {
	t.Helper()
	a, e := auth.NewService(f.pool, auth.NewIssuer(secret, 15*time.Minute), false)
	if e != nil {
		t.Fatal(e)
	}
	hub := gateway.NewHub(5)
	handler := gateway.NewHandler(hub, f.svc, noPresence{}, allowAll{}, a, gateway.Options{AllowedOrigins: []string{"*"}, PingInterval: 100 * time.Millisecond, PongTimeout: time.Second, SendBuffer: 32, MaxFrameBytes: 131072}, quiet)
	router := httpapi.NewRouter(httpapi.Deps{Messaging: f.svc, Keys: keys.New(f.pool), Auth: a, Limiter: allowAll{}, WS: handler, Log: quiet, Ready: f.pool.Ping, InstanceID: "test"})
	s := httptest.NewServer(router)
	t.Cleanup(func() { hub.CloseAll("test done"); s.Close() })
	return s, a, hub
}
func request(t *testing.T, base, method, path, token string, body any, want int) []byte {
	t.Helper()
	var data []byte
	if body != nil {
		var e error
		data, e = json.Marshal(body)
		if e != nil {
			t.Fatal(e)
		}
	}
	req, e := http.NewRequest(method, base+path, bytes.NewReader(data))
	if e != nil {
		t.Fatal(e)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	data, e = io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s: status %d want %d, %s", method, path, res.StatusCode, want, data)
	}
	return data
}
func register(t *testing.T, s *httptest.Server, name string) auth.Tokens {
	t.Helper()
	data := request(t, s.URL, "POST", "/v1/auth/register", "", auth.Credentials{Username: name, Password: "correct-password-123", DeviceID: 1}, 201)
	var tokens auth.Tokens
	if e := json.Unmarshal(data, &tokens); e != nil {
		t.Fatal(e)
	}
	return tokens
}
func TestAuthRotationLogoutAndRevocation(t *testing.T) {
	f := newFixture(t)
	s, a, _ := server(t, f)
	tokens := register(t, s, "alice")
	request(t, s.URL, "POST", "/v1/auth/register", "", auth.Credentials{Username: "alice", Password: "correct-password-123"}, 409)
	request(t, s.URL, "POST", "/v1/auth/login", "", auth.Credentials{Username: "alice", Password: "incorrect-password-123"}, 401)
	request(t, s.URL, "GET", "/v1/conversations", tokens.AccessToken, nil, 200)
	data := request(t, s.URL, "POST", "/v1/auth/refresh", "", map[string]string{"refreshToken": tokens.RefreshToken}, 200)
	var rotated auth.Tokens
	if e := json.Unmarshal(data, &rotated); e != nil {
		t.Fatal(e)
	}
	request(t, s.URL, "GET", "/v1/conversations", tokens.AccessToken, nil, 401)
	request(t, s.URL, "GET", "/v1/conversations", rotated.AccessToken, nil, 200)
	request(t, s.URL, "POST", "/v1/auth/refresh", "", map[string]string{"refreshToken": tokens.RefreshToken}, 401)
	request(t, s.URL, "GET", "/v1/conversations", rotated.AccessToken, nil, 401)
	data = request(t, s.URL, "POST", "/v1/auth/login", "", auth.Credentials{Username: "alice", Password: "correct-password-123"}, 200)
	if e := json.Unmarshal(data, &tokens); e != nil {
		t.Fatal(e)
	}
	request(t, s.URL, "POST", "/v1/auth/logout", tokens.AccessToken, nil, 204)
	request(t, s.URL, "POST", "/v1/auth/refresh", "", map[string]string{"refreshToken": tokens.RefreshToken}, 401)
	request(t, s.URL, "GET", "/v1/conversations", tokens.AccessToken, nil, 401)
	legacy, _, e := auth.NewIssuer(secret, time.Minute).Issue(tokens.UserID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Verify(ctx, legacy); !errors.Is(e, auth.ErrUnauthorized) {
		t.Fatal("dev token accepted while disabled")
	}
	if number(t, f.pool, `SELECT count(*) FROM users WHERE password_hash LIKE '%correct-password%'`) != 0 {
		t.Fatal("password stored directly")
	}
}
func TestRefreshConcurrencyRevokesFamily(t *testing.T) {
	f := newFixture(t)
	s, a, _ := server(t, f)
	tokens := register(t, s, "race_user")
	errs := make(chan error, 2)
	results := make(chan auth.Tokens, 2)
	for range 2 {
		go func() { r, e := a.Refresh(ctx, tokens.RefreshToken); results <- r; errs <- e }()
	}
	wins := 0
	for range 2 {
		if e := <-errs; e == nil {
			wins++
		} else if !errors.Is(e, auth.ErrUnauthorized) {
			t.Fatal(e)
		}
	}
	if wins != 1 {
		t.Fatalf("refresh winners: %d", wins)
	}
	for range 2 {
		r := <-results
		if r.AccessToken != "" {
			if _, e := a.Verify(ctx, r.AccessToken); !errors.Is(e, auth.ErrUnauthorized) {
				t.Fatal("replay did not revoke winner")
			}
		}
	}
}
func TestHTTPContractsAndSessionWebSocket(t *testing.T) {
	f := newFixture(t)
	s, _, _ := server(t, f)
	a := register(t, s, "http_alice")
	b := register(t, s, "http_bob")
	body := request(t, s.URL, "POST", "/v1/conversations", a.AccessToken, map[string]any{"peerUserId": b.UserID}, 200)
	var c domain.Conversation
	if e := json.Unmarshal(body, &c); e != nil {
		t.Fatal(e)
	}
	payload := map[string]any{"clientMessageId": "http-one", "ciphertext": []byte{7, 8, 9}, "protocolMeta": map[string]int{"type": 3}}
	path := "/v1/conversations/" + c.ID.String() + "/messages"
	request(t, s.URL, "POST", path, a.AccessToken, payload, 201)
	request(t, s.URL, "POST", path, a.AccessToken, payload, 200)
	payload["ciphertext"] = []byte{0}
	request(t, s.URL, "POST", path, a.AccessToken, payload, 409)
	request(t, s.URL, "POST", path, b.AccessToken, map[string]any{"plaintext": "must-not-be-accepted"}, 400)
	request(t, s.URL, "POST", "/v1/sync", b.AccessToken, map[string]any{"cursors": map[string]int64{c.ID.String(): 0}}, 200)
	connection, _, e := websocket.Dial(ctx, "ws"+s.URL[4:]+"/ws?access_token="+b.AccessToken, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer connection.CloseNow()
	op, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, _, e = connection.Read(op)
	if e != nil {
		t.Fatal(e)
	} // resync
	request(t, s.URL, "POST", "/v1/auth/logout", b.AccessToken, nil, 204)
	if _, _, e = connection.Read(op); e == nil {
		t.Fatal("revoked idle socket remained active")
	}
	_, res, e := websocket.Dial(ctx, "ws"+s.URL[4:]+"/ws?access_token="+b.AccessToken, nil)
	if e == nil || res == nil || res.StatusCode != 401 {
		t.Fatal("revoked socket handshake accepted")
	}
}

type recordingPublisher struct {
	mu        sync.Mutex
	records   [][]byte
	failFirst bool
	cancel    context.CancelFunc
	onPublish func()
}

func (p *recordingPublisher) ProduceSync(op context.Context, records ...*kgo.Record) kgo.ProduceResults {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := records[0]
	p.records = append(p.records, append([]byte(nil), r.Value...))
	if p.onPublish != nil {
		p.onPublish()
	}
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	if p.failFirst {
		p.failFirst = false
		return kgo.ProduceResults{{Record: r, Err: errors.New("simulated lost broker ACK")}}
	}
	return kgo.ProduceResults{{Record: r}}
}
func (p *recordingPublisher) snapshot() [][]byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([][]byte(nil), p.records...)
}
func startRelay(t *testing.T, f *fixture, pub outbox.Publisher) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	op, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	r := outbox.NewRelay(f.pool, pub, outbox.Config{PollInterval: 20 * time.Millisecond, BatchSize: 10, LockID: 99191, Retention: time.Hour, PublishTimeout: 2 * time.Second, HeartbeatInterval: 40 * time.Millisecond}, quiet)
	go func() { defer close(done); r.Run(op) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("relay failed to stop")
		}
	})
	return cancel, done
}

type countPusher struct{ count int }

func (p *countPusher) PushToUser(uuid.UUID, []byte) int { p.count++; return 1 }
func TestRelayCrashBetweenPublishAndMarkIsDeduped(t *testing.T) {
	f := newFixture(t)
	if _, e := f.svc.Send(ctx, f.command("crash")); e != nil {
		t.Fatal(e)
	}
	op, cancel := context.WithCancel(ctx)
	pub := &recordingPublisher{cancel: cancel}
	r := outbox.NewRelay(f.pool, pub, outbox.Config{PollInterval: 10 * time.Millisecond, BatchSize: 10, LockID: 99191, Retention: time.Hour}, quiet)
	r.Run(op)
	if number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) != 1 {
		t.Fatal("marked after cancelled/crashed publish")
	}
	cancel2, done := startRelay(t, f, pub)
	eventually(t, 3*time.Second, func() bool { return number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) == 0 })
	cancel2()
	<-done
	raw := pub.snapshot()
	if len(raw) != 2 || !bytes.Equal(raw[0], raw[1]) {
		t.Fatal("replay changed event")
	}
	pusher := &countPusher{}
	router := delivery.NewRouter(pusher, 100)
	for _, event := range raw {
		if e := router.Handle(event); e != nil {
			t.Fatal(e)
		}
	}
	if pusher.count != 1 {
		t.Fatal("duplicate push")
	}
}
func TestRelayRetryAndLeadership(t *testing.T) {
	f := newFixture(t)
	first := f.command("first")
	if _, e := f.svc.Send(ctx, first); e != nil {
		t.Fatal(e)
	}
	if _, e := f.svc.Send(ctx, f.command("second")); e != nil {
		t.Fatal(e)
	}
	pub := &recordingPublisher{failFirst: true}
	cancel1, done1 := startRelay(t, f, pub)
	cancel2, done2 := startRelay(t, f, pub)
	eventually(t, 4*time.Second, func() bool { return number(t, f.pool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`) == 0 })
	cancel1()
	cancel2()
	<-done1
	<-done2
	rows := pub.snapshot()
	if len(rows) != 3 || !bytes.Equal(rows[0], rows[1]) || bytes.Equal(rows[1], rows[2]) {
		t.Fatal("published past failed head or duplicate leaders")
	}
	if number(t, f.pool, `SELECT sum(attempts) FROM outbox`) != 1 {
		t.Fatal("retry not recorded")
	}
	// The session lock must be released when a leader returns.
	conn, e := f.pool.Acquire(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var got bool
	e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(99191)`).Scan(&got)
	if e != nil || !got {
		t.Fatal("leadership leaked into pool")
	}
	_, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock(99191)`)
	conn.Release()
}
func TestCrossInstanceDelivery(t *testing.T) {
	f := newFixture(t)
	sa, _, ha := server(t, f)
	sb, _, hb := server(t, f)
	alice := register(t, sa, "cross_alice")
	bob := register(t, sb, "cross_bob")
	cv, e := f.svc.CreateDirect(ctx, alice.UserID, bob.UserID)
	if e != nil {
		t.Fatal(e)
	}
	brokers := []string{env("TEST_KAFKA_BROKERS", "localhost:9094")}
	producer, e := kafkaplatform.NewProducer(brokers, "test-producer")
	if e != nil {
		t.Fatal(e)
	}
	defer producer.Close()
	consumerCtx, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	for i, hub := range []*gateway.Hub{ha, hb} {
		consumer, e := kafkaplatform.NewGatewayConsumer(brokers, "be1-"+f.schema+fmt.Sprint(i), false, false, "chat.messages", "chat.receipts")
		if e != nil {
			t.Fatal(e)
		}
		defer consumer.Close()
		router := delivery.NewRouter(hub, 10000)
		kc := delivery.NewKafkaConsumer(consumer, producer, router, "chat.dlq", quiet)
		wg.Add(1)
		go func() { defer wg.Done(); kc.Run(consumerCtx) }()
	}
	defer func() { stop(); wg.Wait() }()
	bobWS, _, e := websocket.Dial(ctx, "ws"+sb.URL[4:]+"/ws?access_token="+bob.AccessToken, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer bobWS.CloseNow()
	aliceWS, _, e := websocket.Dial(ctx, "ws"+sa.URL[4:]+"/ws?access_token="+alice.AccessToken, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer aliceWS.CloseNow()
	op, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	bobFrames := readFrames(op, bobWS)
	aliceFrames := readFrames(op, aliceWS)
	relayCancel, done := startRelay(t, f, producer)
	defer func() { relayCancel(); <-done }()
	request(t, sa.URL, "POST", "/v1/conversations/"+cv.ID.String()+"/messages", alice.AccessToken, map[string]any{"clientMessageId": "cross", "ciphertext": []byte{1, 2, 3}, "protocolMeta": map[string]int{"type": 3}}, 201)
	frame := awaitFrame(t, op, bobFrames, "message")
	var accepted events.MessageAccepted
	if e = json.Unmarshal(frame.Payload, &accepted); e != nil || accepted.Seq != 1 || accepted.SenderID != alice.UserID {
		t.Fatal("bad message event")
	}
	request(t, sb.URL, "POST", "/v1/messages/"+accepted.MessageID.String()+"/receipts", bob.AccessToken, map[string]string{"state": "read"}, 204)
	_ = awaitFrame(t, op, aliceFrames, "receipt")
}

// Clients keep reading continuously so pings are answered during group startup.
func readFrames(op context.Context, ws *websocket.Conn) <-chan gateway.Frame {
	frames := make(chan gateway.Frame, 16)
	go func() {
		defer close(frames)
		for {
			_, raw, e := ws.Read(op)
			if e != nil {
				return
			}
			var f gateway.Frame
			if json.Unmarshal(raw, &f) != nil {
				return
			}
			select {
			case frames <- f:
			case <-op.Done():
				return
			}
		}
	}()
	return frames
}
func awaitFrame(t *testing.T, op context.Context, frames <-chan gateway.Frame, kind string) gateway.Frame {
	t.Helper()
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				t.Fatal("socket closed while waiting for " + kind)
			}
			if frame.Type == kind {
				return frame
			}
		case <-op.Done():
			t.Fatal("timed out waiting for " + kind)
		}
	}
}
