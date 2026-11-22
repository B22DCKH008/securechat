package messaging

import (
	"context"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/events"
	"github.com/securechat/backend/internal/platform/postgres"
	"github.com/securechat/backend/internal/store"
)

// Group chat with pairwise fan-out (RS31, RS34, KF17).
//
// Rules:
//   - The creator is the owner. Only the owner adds/removes others or renames.
//   - Any member may leave; if the owner leaves, the earliest remaining member
//     becomes owner.
//   - A member added later sees messages with seq > joinedSeq, starting with the
//     members_added system message. Older ciphertext was never encrypted for them.
//   - A removed/departed member loses server-side access immediately; sync then
//     reports the departure. Messages after removal are not addressed to them.
//   - Every change is a kind="system" message with its own seq and outbox event,
//     in the same transaction, so realtime and cursor sync see it in order.

// CreateGroup creates a group with the caller as owner.
func (s *Service) CreateGroup(ctx context.Context, owner uuid.UUID, title string, memberIDs []uuid.UUID) (domain.Conversation, error) {
	title, ok := domain.ValidGroupTitle(title)
	if !ok {
		return domain.Conversation{}, domain.ErrInvalidInput
	}
	members, err := s.newUsers(ctx, owner, memberIDs, domain.MaxGroupMembers-1)
	if err != nil {
		return domain.Conversation{}, err
	}
	var c domain.Conversation
	err = postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		if c, err = store.CreateGroup(ctx, tx, owner, title, members); err != nil {
			return err
		}
		seq, _, err := store.NextSeqForKind(ctx, tx, c.ID)
		if err != nil {
			return err
		}
		c.LastSeq = seq
		return s.appendSystem(ctx, tx, c.ID, seq, owner, domain.SystemEvent{
			Type: domain.SystemGroupCreated, ActorID: owner, UserIDs: members, Title: title,
		}, members)
	})
	return c, err
}

// ListMembers returns members of a conversation the caller belongs to.
func (s *Service) ListMembers(ctx context.Context, userID, convID uuid.UUID) ([]domain.Member, error) {
	if err := s.requireMember(ctx, convID, userID); err != nil {
		return nil, err
	}
	return store.ListMembers(ctx, s.pool, convID)
}

// AddMembers adds users to a group (owner only). Already-present users are
// ignored; if nobody is new, nothing is written.
func (s *Service) AddMembers(ctx context.Context, actor, convID uuid.UUID, userIDs []uuid.UUID) ([]domain.Member, error) {
	candidates, err := s.newUsers(ctx, actor, userIDs, domain.MaxGroupMembers-1)
	if err != nil {
		return nil, err
	}
	err = postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		me, err := store.LockMemberShare(ctx, tx, convID, actor)
		if err != nil {
			return err
		}
		if me.Role != domain.RoleOwner {
			return domain.ErrNotMember
		}
		seq, kind, err := store.NextSeqForKind(ctx, tx, convID)
		if err != nil {
			return err
		}
		if kind != domain.KindGroup {
			return domain.ErrInvalidInput
		}
		// Read under the conversation lock so concurrent adds cannot both pass
		// the size limit.
		current, err := store.Members(ctx, tx, convID)
		if err != nil {
			return err
		}
		added := slices.DeleteFunc(slices.Clone(candidates), func(id uuid.UUID) bool { return slices.Contains(current, id) })
		if len(added) == 0 {
			return errNothingToDo
		}
		if len(current)+len(added) > domain.MaxGroupMembers {
			return domain.ErrInvalidInput
		}
		// joined_seq = seq-1: new members see the system message announcing them.
		if err := store.AddMembers(ctx, tx, convID, added, seq-1); err != nil {
			return err
		}
		return s.appendSystem(ctx, tx, convID, seq, actor, domain.SystemEvent{
			Type: domain.SystemMembersAdded, ActorID: actor, UserIDs: added,
		}, without(append(current, added...), actor))
	})
	if err != nil && err != errNothingToDo {
		return nil, err
	}
	return store.ListMembers(ctx, s.pool, convID)
}

// RemoveMember removes target (owner only) or lets the caller leave (target == actor).
func (s *Service) RemoveMember(ctx context.Context, actor, convID, target uuid.UUID) error {
	if target == uuid.Nil {
		return domain.ErrInvalidInput
	}
	return postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		// Lock every member row (sorted) before the conversation row: owner
		// promotion may update another member's row.
		locked, err := store.LockMembers(ctx, tx, convID, nil)
		if err != nil {
			return err
		}
		me, ok := locked[actor]
		if !ok {
			return domain.ErrNotMember
		}
		victim, ok := locked[target]
		if !ok {
			return domain.ErrNotFound
		}
		if actor != target && me.Role != domain.RoleOwner {
			return domain.ErrNotMember
		}
		seq, kind, err := store.NextSeqForKind(ctx, tx, convID)
		if err != nil {
			return err
		}
		if kind != domain.KindGroup {
			return domain.ErrInvalidInput
		}
		before := make([]uuid.UUID, 0, len(locked))
		for id := range locked {
			before = append(before, id)
		}
		slices.SortFunc(before, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
		if err := store.RemoveMember(ctx, tx, convID, target, seq); err != nil {
			return err
		}
		ev := domain.SystemEvent{Type: domain.SystemMemberRemoved, ActorID: actor, UserIDs: []uuid.UUID{target}}
		if actor == target {
			ev.Type = domain.SystemMemberLeft
		}
		if victim.Role == domain.RoleOwner {
			owner, err := store.PromoteOldestMember(ctx, tx, convID)
			if err != nil {
				return err
			}
			if owner != uuid.Nil {
				ev.NewOwner = &owner
			}
		}
		// The removed user is notified too (its client then drops the group).
		return s.appendSystem(ctx, tx, convID, seq, actor, ev, without(before, actor))
	})
}

// RenameGroup changes the title (owner only).
func (s *Service) RenameGroup(ctx context.Context, actor, convID uuid.UUID, title string) error {
	title, ok := domain.ValidGroupTitle(title)
	if !ok {
		return domain.ErrInvalidInput
	}
	return postgres.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		me, err := store.LockMemberShare(ctx, tx, convID, actor)
		if err != nil {
			return err
		}
		if me.Role != domain.RoleOwner {
			return domain.ErrNotMember
		}
		seq, kind, err := store.NextSeqForKind(ctx, tx, convID)
		if err != nil {
			return err
		}
		if kind != domain.KindGroup {
			return domain.ErrInvalidInput
		}
		if err := store.SetTitle(ctx, tx, convID, title); err != nil {
			return err
		}
		members, err := store.Members(ctx, tx, convID)
		if err != nil {
			return err
		}
		return s.appendSystem(ctx, tx, convID, seq, actor, domain.SystemEvent{
			Type: domain.SystemTitleChanged, ActorID: actor, Title: title,
		}, without(members, actor))
	})
}

var errNothingToDo = fmt.Errorf("no membership change")

// newUsers dedupes ids, drops the actor, bounds the count and checks existence.
func (s *Service) newUsers(ctx context.Context, actor uuid.UUID, ids []uuid.UUID, maxCount int) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			return nil, domain.ErrInvalidInput
		}
		if id != actor && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) == 0 || len(out) > maxCount {
		return nil, domain.ErrInvalidInput
	}
	n, err := store.CountUsers(ctx, s.pool, out)
	if err != nil {
		return nil, err
	}
	if n != len(out) {
		return nil, domain.ErrNotFound
	}
	return out, nil
}

// appendSystem stores a system message at seq and its outbox event. With no
// recipients (e.g. the last member left) no event is emitted: an event without
// recipients would be a poison record for the gateway consumer.
func (s *Service) appendSystem(ctx context.Context, tx pgx.Tx, convID uuid.UUID, seq int64, actor uuid.UUID, ev domain.SystemEvent, recipients []uuid.UUID) error {
	msg := domain.Message{
		ID:              uuid.New(),
		Kind:            domain.MessageKindSystem,
		ClientMessageID: domain.SystemClientMessageID(),
		ConversationID:  convID,
		Seq:             seq,
		SenderID:        actor,
		ProtocolMeta:    []byte(`{}`),
		System:          &ev,
		CreatedAt:       s.now().UTC(),
	}
	if _, err := store.InsertMessage(ctx, tx, msg); err != nil {
		return fmt.Errorf("insert system message: %w", err)
	}
	if len(recipients) == 0 {
		return nil
	}
	env, err := events.New(events.TypeMessageAccepted, events.MessageAccepted{
		MessageID:       msg.ID,
		ClientMessageID: msg.ClientMessageID,
		ConversationID:  convID,
		Seq:             seq,
		SenderID:        actor,
		Recipients:      recipients,
		Ciphertext:      []byte{},
		ProtocolMeta:    msg.ProtocolMeta,
		AcceptedAt:      msg.CreatedAt,
		Kind:            domain.MessageKindSystem,
		System:          &ev,
	}, msg.CreatedAt)
	if err != nil {
		return err
	}
	return store.InsertOutbox(ctx, tx, s.topics.Messages, convID.String(), env)
}
