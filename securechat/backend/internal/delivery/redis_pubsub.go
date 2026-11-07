package delivery

import (
	"context"
	"errors"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

// RedisSubscriber is the fallback / comparison transport behind
// DELIVERY_TRANSPORT=redis (KF16, EXP13). Redis Pub/Sub is NOT durable:
// messages published while an instance is down are lost for realtime and only
// recovered via PostgreSQL sync. That is exactly what EXP13 should measure.
type RedisSubscriber struct {
	rdb      *redis.Client
	router   *Router
	channels []string
	log      *slog.Logger
}

func NewRedisSubscriber(rdb *redis.Client, router *Router, log *slog.Logger, channels ...string) *RedisSubscriber {
	return &RedisSubscriber{rdb: rdb, router: router, channels: channels, log: log.With("component", "redis-subscriber")}
}

func (s *RedisSubscriber) Run(ctx context.Context) {
	sub := s.rdb.Subscribe(ctx, s.channels...)
	defer sub.Close()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			if err := s.router.Handle([]byte(m.Payload)); err != nil {
				s.log.Warn("handle failed", "channel", m.Channel, "err", err)
			}
		}
	}
}

// ErrRedisPublisherNotImplemented: the relay side for Redis transport is not built yet.
//
// TODO(BE2, KF16): implement an outbox.Publisher that PUBLISHes envelopes to the
// Redis channel named after the topic, so the relay can switch transport by flag.
var ErrRedisPublisherNotImplemented = errors.New("redis publisher not implemented")
