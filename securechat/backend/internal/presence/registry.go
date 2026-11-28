// Package presence keeps the Redis connection registry: which user is connected
// to which instance (RS12, RS14, RS20, RS29). Data is ephemeral and TTL-bound;
// it is NEVER on the critical delivery path (Kafka broadcast + PostgreSQL sync are).
//
// Layout (requires Redis >= 7.4 for per-field TTL):
//
//	HASH presence:user:<userId>       field=<connId> value=<instanceId>
//	     each field has its own TTL (HEXPIRE) refreshed by that connection's
//	     heartbeat, so one crashed connection/instance expires individually;
//	     the key TTL is refreshed too and only garbage-collects empty hashes.
//	SET  presence:instance:<instanceId> member=<userId>|<connId>
//	     index used to remove this instance's entries on restart/shutdown.
package presence

import (
	"context"
	"strings"
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

func userKey(userID uuid.UUID) string   { return "presence:user:" + userID.String() }
func (r *Registry) instanceKey() string { return "presence:instance:" + r.instanceID }

// Register records connID of userID on this instance.
func (r *Registry) Register(ctx context.Context, userID uuid.UUID, connID string) error {
	// Plain pipeline (not MULTI): an unsupported command must not abort the others.
	_, err := r.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, userKey(userID), connID, r.instanceID)
		p.HExpire(ctx, userKey(userID), r.ttl, connID)
		p.Expire(ctx, userKey(userID), r.ttl)
		p.SAdd(ctx, r.instanceKey(), userID.String()+"|"+connID)
		return nil
	})
	return err
}

// Refresh extends the TTL of one connection; called on every heartbeat.
// If the field already expired (e.g. Redis restarted), it is recreated.
func (r *Registry) Refresh(ctx context.Context, userID uuid.UUID, connID string) error {
	res, err := r.rdb.HExpire(ctx, userKey(userID), r.ttl, connID).Result()
	if err != nil {
		return err
	}
	if len(res) == 1 && res[0] == -2 { // field or key missing
		return r.Register(ctx, userID, connID)
	}
	return r.rdb.Expire(ctx, userKey(userID), r.ttl).Err()
}

func (r *Registry) Unregister(ctx context.Context, userID uuid.UUID, connID string) error {
	_, err := r.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HDel(ctx, userKey(userID), connID)
		p.SRem(ctx, r.instanceKey(), userID.String()+"|"+connID)
		return nil
	})
	return err
}

// Lookup returns connId → instanceId of live connections. Empty map means offline.
func (r *Registry) Lookup(ctx context.Context, userID uuid.UUID) (map[string]string, error) {
	return r.rdb.HGetAll(ctx, userKey(userID)).Result()
}

// IsOnline uses HGETALL rather than HLEN so lazily-reclaimed expired fields
// are never counted.
func (r *Registry) IsOnline(ctx context.Context, userID uuid.UUID) (bool, error) {
	m, err := r.Lookup(ctx, userID)
	return len(m) > 0, err
}

// CleanupInstance removes every entry this instance registered earlier
// (RS29). Call on startup, before accepting connections, because a crashed
// process leaves entries that would otherwise live until their TTL; and on
// graceful shutdown. Only fields whose value is still this instance are deleted.
func (r *Registry) CleanupInstance(ctx context.Context) (int, error) {
	members, err := r.rdb.SMembers(ctx, r.instanceKey()).Result()
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, m := range members {
		user, conn, ok := strings.Cut(m, "|")
		if !ok {
			continue
		}
		n, err := deleteIfOwner.Run(ctx, r.rdb, []string{"presence:user:" + user}, conn, r.instanceID).Int()
		if err != nil {
			return removed, err
		}
		removed += n
	}
	return removed, r.rdb.Del(ctx, r.instanceKey()).Err()
}

var deleteIfOwner = redis.NewScript(`
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0`)
