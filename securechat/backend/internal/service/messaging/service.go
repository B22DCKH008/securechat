// Package messaging implements send / ACK / sync / history use-cases (RS1-RS8).
//
// Invariants:
//   - A message exists only once committed in PostgreSQL (with its outbox row) – KF1.
//   - The server-accepted ACK is returned only after commit – doc §3.1 step 5.
//   - Kafka is never called from here; the outbox relay publishes asynchronously.
package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/events"
	"github.com/securechat/backend/internal/metrics"
	"github.com/securechat/backend/internal/platform/postgres"
	"github.com/securechat/backend/internal/store"
)

type Topics struct {
	Messages string
	Receipts string
}

type Service struct {
	pool          *pgxpool.Pool
	topics        Topics
	maxCiphertext int
	now           func() time.Time
}

func New(pool *pgxpool.Pool, topics Topics, maxCiphertext int) *Service {
	return &Service{pool: pool, topics: topics, maxCiphertext: maxCiphertext, now: time.Now}
}

var errLostIdempotencyRace = errors.New("concurrent insert with same clientMessageId")

// Send persists a ciphertext message + MessageAccepted outbox row atomically.
func (s *Service) Send(ctx context.Context, cmd domain.SendCommand) (domain.SendResult, error) {
	start := time.Now()
	defer func() { metrics.SendLatency.Observe(time.Since(start).Seconds()) }()

	if err := cmd.Validate(s.maxCiphertext); err != nil {
		return domain.SendResult{}, err
	}
	if len(cmd.ProtocolMeta) == 0 {
		cmd.ProtocolMeta = json.RawMessage(`{}`)
	}
	if cmd.ClientCreatedAt != nil {
		at := cmd.ClientCreatedAt.UTC().Truncate(time.Microsecond)
		cmd.ClientCreatedAt = &at
	}
	if err := s.requireMember(ctx, cmd.ConversationID, cmd.SenderID); err != nil {
		return domain.SendResult{}, err
	}

	// Fast idempotency path: client retried after a lost ACK (RS1, RS2, RS37).
	if existing, err := store.FindByClientID(ctx, s.pool, cmd.SenderID, cmd.ClientMessageID); err == nil {
		return s.duplicate(ctx, existing, cmd)
	} else if !errors.Is(err, domain.ErrNotFound) {
		return domain.SendResult{}, err
	}

	var msg domain.Message
	err := postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := store.LockMember(ctx, tx, cmd.ConversationID, cmd.SenderID); err != nil {
			return err
		}
		seq, err := store.NextSeq(ctx, tx, cmd.ConversationID)
		if err != nil {
			return fmt.Errorf("next seq: %w", err)
		}
		msg = domain.Message{
			ID:              uuid.New(),
			ClientMessageID: cmd.ClientMessageID,
			ConversationID:  cmd.ConversationID,
			Seq:             seq,
			SenderID:        cmd.SenderID,
			Ciphertext:      cmd.Ciphertext,
			ProtocolMeta:    cmd.ProtocolMeta,
			ClientCreatedAt: cmd.ClientCreatedAt,
			CreatedAt:       s.now().UTC(),
		}
		inserted, err := store.InsertMessage(ctx, tx, msg)
		if err != nil {
			return fmt.Errorf("insert message: %w", err)
		}
		if !inserted {
			return errLostIdempotencyRace // rollback also undoes the seq increment
		}

		members, err := store.Members(ctx, tx, cmd.ConversationID)
		if err != nil {
			return err
		}
		env, err := events.New(events.TypeMessageAccepted, events.MessageAccepted{
			MessageID:       msg.ID,
			ClientMessageID: msg.ClientMessageID,
			ConversationID:  msg.ConversationID,
			Seq:             msg.Seq,
			SenderID:        msg.SenderID,
			Recipients:      without(members, msg.SenderID),
			Ciphertext:      msg.Ciphertext,
			ProtocolMeta:    msg.ProtocolMeta,
			AcceptedAt:      msg.CreatedAt,
		}, msg.CreatedAt)
		if err != nil {
			return err
		}
		return store.InsertOutbox(ctx, tx, s.topics.Messages, msg.ConversationID.String(), env)
	})

	if errors.Is(err, errLostIdempotencyRace) {
		existing, ferr := store.FindByClientID(ctx, s.pool, cmd.SenderID, cmd.ClientMessageID)
		if ferr != nil {
			return domain.SendResult{}, ferr
		}
		return s.duplicate(ctx, existing, cmd)
	}
	if err != nil {
		return domain.SendResult{}, err
	}
	metrics.MessagesAccepted.Inc()
	return domain.SendResult{Message: msg}, nil
}

func (s *Service) duplicate(ctx context.Context, m domain.Message, cmd domain.SendCommand) (domain.SendResult, error) {
	if m.ConversationID != cmd.ConversationID {
		return domain.SendResult{}, domain.ErrConflict
	}
	match, err := store.MatchesRetry(ctx, s.pool, m.ID, cmd)
	if err != nil {
		return domain.SendResult{}, err
	}
	if !match {
		return domain.SendResult{}, domain.ErrConflict
	}
	metrics.MessagesDuplicate.Inc()
	return domain.SendResult{Message: m, Duplicate: true}, nil
}

// Acknowledge records a delivered/read receipt and emits a receipt event (RS6).
func (s *Service) Acknowledge(ctx context.Context, userID, messageID uuid.UUID, state domain.DeliveryState) error {
	if !state.ValidReceipt() {
		return domain.ErrInvalidInput
	}
	msg, err := store.GetMessage(ctx, s.pool, messageID)
	if err != nil {
		return err
	}
	if err := s.requireMember(ctx, msg.ConversationID, userID); err != nil {
		return err
	}
	if msg.SenderID == userID {
		return domain.ErrNotMember // Only a recipient establishes delivered/read.
	}

	return postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := store.LockMember(ctx, tx, msg.ConversationID, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT id FROM conversations WHERE id=$1 FOR UPDATE`, msg.ConversationID); err != nil {
			return err
		}
		now := s.now().UTC()
		changed, err := store.UpsertReceipt(ctx, tx, messageID, userID, state, now)
		if err != nil || !changed {
			return err // idempotent: repeated ACK emits nothing
		}
		evType := events.TypeMessageDelivered
		if state == domain.StateRead {
			evType = events.TypeMessageRead
		}
		revision, err := store.AppendReceiptChange(ctx, tx, msg, userID, state, now)
		if err != nil {
			return err
		}
		env, err := events.New(evType, events.Receipt{
			ReceiptSeq: revision,
			MessageID:  msg.ID, ConversationID: msg.ConversationID, Seq: msg.Seq,
			RecipientID: userID, SenderID: msg.SenderID, State: string(state), At: now,
		}, now)
		if err != nil {
			return err
		}
		return store.InsertOutbox(ctx, tx, s.topics.Receipts, msg.ConversationID.String(), env)
	})
}

// History returns older messages for scrolling back (RS8). Newest first.
func (s *Service) History(ctx context.Context, userID, convID uuid.UUID, beforeSeq int64, limit int) ([]domain.Message, error) {
	if beforeSeq < 0 {
		return nil, domain.ErrInvalidInput
	}
	if err := s.requireMember(ctx, convID, userID); err != nil {
		return nil, err
	}
	messages, err := store.MessagesBefore(ctx, s.pool, convID, beforeSeq, clampLimit(limit))
	if err != nil {
		return nil, err
	}
	messages, _ = boundMessagePage(messages, false)
	return messages, nil
}

// SyncResult is one page per conversation.
type SyncResult struct {
	ConversationID    uuid.UUID        `json:"conversationId"`
	Messages          []domain.Message `json:"messages"`
	NextCursor        int64            `json:"nextCursor"`
	HasMore           bool             `json:"hasMore"`
	Receipts          []domain.Receipt `json:"receipts"`
	NextReceiptCursor int64            `json:"nextReceiptCursor"`
	HasMoreReceipts   bool             `json:"hasMoreReceipts"`
}

// Sync returns messages after the client's per-conversation cursor (RS3, RS4, SC3).
// Depends on PostgreSQL only – works even when Kafka is down (KF8).
func (s *Service) Sync(ctx context.Context, userID uuid.UUID, cursors map[uuid.UUID]int64, limit int) ([]SyncResult, error) {
	return s.SyncWithReceipts(ctx, userID, cursors, nil, limit)
}

func (s *Service) SyncWithReceipts(ctx context.Context, userID uuid.UUID, cursors, receiptCursors map[uuid.UUID]int64, limit int) ([]SyncResult, error) {
	if limit < 0 || limit > 200 {
		return nil, domain.ErrInvalidInput
	}
	if len(cursors) > 500 || len(receiptCursors) > 500 {
		return nil, domain.ErrInvalidInput
	}
	for _, cursor := range cursors {
		if cursor < 0 {
			return nil, domain.ErrInvalidInput
		}
	}
	for _, cursor := range receiptCursors {
		if cursor < 0 {
			return nil, domain.ErrInvalidInput
		}
	}
	limit = clampLimit(limit)
	convs, err := store.ListConversations(ctx, s.pool, userID)
	if err != nil {
		return nil, err
	}
	members := make(map[uuid.UUID]bool, len(convs))
	for _, c := range convs {
		members[c.ID] = true
	}
	for id := range cursors {
		if !members[id] {
			return nil, domain.ErrNotMember
		}
	}
	for id := range receiptCursors {
		if !members[id] {
			return nil, domain.ErrNotMember
		}
	}
	out := make([]SyncResult, 0, len(convs))
	for _, c := range convs {
		cursor := cursors[c.ID]
		msgs, err := store.MessagesAfter(ctx, s.pool, c.ID, cursor, limit+1)
		if err != nil {
			return nil, err
		}
		res := SyncResult{ConversationID: c.ID, NextCursor: cursor, NextReceiptCursor: receiptCursors[c.ID]}
		if len(msgs) > limit {
			msgs, res.HasMore = msgs[:limit], true
		}
		if len(msgs) > 0 {
			msgs, res.HasMore = boundMessagePage(msgs, res.HasMore)
			res.NextCursor = msgs[len(msgs)-1].Seq
		}
		res.Messages = msgs
		receipts, err := store.ReceiptChangesAfter(ctx, s.pool, c.ID, receiptCursors[c.ID], limit+1)
		if err != nil {
			return nil, err
		}
		if len(receipts) > limit {
			receipts, res.HasMoreReceipts = receipts[:limit], true
		}
		res.Receipts = receipts
		if len(receipts) > 0 {
			res.NextReceiptCursor = receipts[len(receipts)-1].ReceiptSeq
		}
		if len(msgs) == 0 && len(receipts) == 0 {
			continue
		}
		out = append(out, res)
	}
	// TODO(BE1, RS22): one query per conversation is fine for MVP; batch with
	// LATERAL join if the DB benchmark shows it matters.
	return out, nil
}

// Bound each message page to roughly 1 MiB serialized, in addition to row count.
func boundMessagePage(messages []domain.Message, hasMore bool) ([]domain.Message, bool) {
	size := 0
	for i, m := range messages {
		b, _ := json.Marshal(m)
		size += len(b)
		if size > 1<<20 && i > 0 {
			return messages[:i], true
		}
	}
	return messages, hasMore
}

// CreateDirect returns (or creates) the 1:1 conversation with peer.
func (s *Service) CreateDirect(ctx context.Context, userID, peerID uuid.UUID) (domain.Conversation, error) {
	if userID == peerID {
		return domain.Conversation{}, domain.ErrInvalidInput
	}
	ok, err := store.UserExists(ctx, s.pool, peerID)
	if err != nil {
		return domain.Conversation{}, err
	}
	if !ok {
		return domain.Conversation{}, domain.ErrNotFound
	}
	var c domain.Conversation
	err = postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		c, err = store.GetOrCreateDirect(ctx, tx, userID, peerID)
		return err
	})
	return c, err
}

func (s *Service) ListConversations(ctx context.Context, userID uuid.UUID) ([]domain.Conversation, error) {
	return store.ListConversations(ctx, s.pool, userID)
}

func (s *Service) requireMember(ctx context.Context, convID, userID uuid.UUID) error {
	ok, err := store.IsMember(ctx, s.pool, convID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return domain.ErrNotMember
	}
	return nil
}

func without(ids []uuid.UUID, x uuid.UUID) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id != x {
			out = append(out, id)
		}
	}
	return out
}

func clampLimit(n int) int {
	switch {
	case n <= 0:
		return 50
	case n > 200:
		return 200
	}
	return n
}
