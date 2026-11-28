package delivery

import (
	"context"
	"log/slog"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
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

// RedisPublisher is the relay side of DELIVERY_TRANSPORT=redis (KF16, EXP13).
// It implements outbox.Publisher: each record value (the unchanged event
// envelope, ciphertext only) is PUBLISHed to a channel named after its topic.
//
// A successful PUBLISH only means Redis accepted it; subscribers that are
// down or reconnecting miss the event for realtime and recover via
// PostgreSQL sync. The outbox row is still marked published afterwards.
type RedisPublisher struct{ rdb *redis.Client }

func NewRedisPublisher(rdb *redis.Client) *RedisPublisher { return &RedisPublisher{rdb: rdb} }

func (p *RedisPublisher) ProduceSync(ctx context.Context, records ...*kgo.Record) kgo.ProduceResults {
	results := make(kgo.ProduceResults, 0, len(records))
	for _, r := range records {
		err := p.rdb.Publish(ctx, r.Topic, r.Value).Err()
		results = append(results, kgo.ProduceResult{Record: r, Err: err})
	}
	return results
}
