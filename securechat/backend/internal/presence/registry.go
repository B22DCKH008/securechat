// Package presence keeps the Redis connection registry: which user is connected
// to which instance (RS12, RS14, RS20). Data is ephemeral and TTL-bound; it is
// NEVER on the critical delivery path (Kafka broadcast + PostgreSQL sync are).
//
// Layout: HASH presence:user:<userId>  field=<connId>  value=<instanceId>
//
//	key TTL refreshed by heartbeat; stale entries expire automatically.
package presence

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type Registry struct {
	rdb        *redis.Client
	instanceID string
	ttl        time.Duration
}

func NewRegistry(rdb *redis.Client, instanceID string, ttl time.Duration) *Registry {
	return &Registry{rdb: rdb, instanceID: instanceID, ttl: ttl}
}

func key(userID uuid.UUID) string { return "presence:user:" + userID.String() }

func (r *Registry) Register(ctx context.Context, userID uuid.UUID, connID string) error {
	pipe := r.rdb.TxPipeline()
	pipe.HSet(ctx, key(userID), connID, r.instanceID)
	pipe.Expire(ctx, key(userID), r.ttl)
	_, err := pipe.Exec(ctx)
	return err
}

// Refresh extends TTL; called on every heartbeat.
func (r *Registry) Refresh(ctx context.Context, userID uuid.UUID) error {
	return r.rdb.Expire(ctx, key(userID), r.ttl).Err()
}

func (r *Registry) Unregister(ctx context.Context, userID uuid.UUID, connID string) error {
	return r.rdb.HDel(ctx, key(userID), connID).Err()
}

// Lookup returns connId → instanceId. Empty map means offline.
func (r *Registry) Lookup(ctx context.Context, userID uuid.UUID) (map[string]string, error) {
	return r.rdb.HGetAll(ctx, key(userID)).Result()
}

func (r *Registry) IsOnline(ctx context.Context, userID uuid.UUID) (bool, error) {
	n, err := r.rdb.HLen(ctx, key(userID)).Result()
	return n > 0, err
}

// TODO(BE2, RS14): per-connection TTL (HASH field TTL needs Redis 7.4 HEXPIRE, or
// use one key per connection) so a crashed instance's entries expire individually.
// TODO(BE2, RS29): on startup, remove entries whose value == this instanceID.
