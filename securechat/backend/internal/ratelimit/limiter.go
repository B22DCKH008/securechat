// Package ratelimit implements a basic per-user fixed-window limiter in Redis
// (RS19, RS30, RS40 – "MUST (basic)").
//
// Graceful degradation (RS39): if Redis is unavailable the limiter FAILS OPEN and
// the caller still has the per-connection local limit in the WS gateway.
package ratelimit

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

type Limiter struct {
	rdb    *redis.Client
	limit  int
	window time.Duration
	log    *slog.Logger
}

func New(rdb *redis.Client, perSecond int, log *slog.Logger) *Limiter {
	return &Limiter{rdb: rdb, limit: perSecond, window: time.Second, log: log}
}

// Allow reports whether one more action for (scope, subject) is permitted.
func (l *Limiter) Allow(ctx context.Context, scope, subject string) bool {
	if l == nil || l.limit <= 0 {
		return true
	}
	bucket := time.Now().UnixNano() / int64(l.window)
	k := fmt.Sprintf("rl:%s:%s:%d", scope, subject, bucket)

	pipe := l.rdb.TxPipeline()
	incr := pipe.Incr(ctx, k)
	pipe.Expire(ctx, k, 2*l.window)
	if _, err := pipe.Exec(ctx); err != nil {
		l.log.Warn("rate limiter unavailable; failing open", "err", err)
		return true
	}
	return incr.Val() <= int64(l.limit)
}

// TODO(BE2, RS30): token bucket (smoother) + separate limits for send vs ack vs sync.
