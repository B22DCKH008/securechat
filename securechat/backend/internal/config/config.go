// Package config loads all runtime configuration from environment variables (INF2).
// Never hard-code secrets; every value has a safe development default.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// DeliveryTransport selects the realtime fan-out path (KF16 / EXP13).
type DeliveryTransport string

const (
	TransportKafka DeliveryTransport = "kafka"
	TransportRedis DeliveryTransport = "redis" // fallback / comparison only
)

type Config struct {
	InstanceID string // stable per instance, e.g. "gw-A" (KF10)
	HTTPAddr   string
	LogLevel   string

	PostgresDSN      string
	PostgresMaxConns int32

	RedisAddr     string
	RedisPassword string
	RedisDB       int

	KafkaBrokers         []string
	KafkaTopicMessages   string
	KafkaTopicReceipts   string
	KafkaTopicRetry      string
	KafkaTopicDLQ        string
	KafkaConsumerGroup   string // defaults to InstanceID: one group per instance (KF7)
	KafkaStartFromLatest bool
	KafkaStaticMember    bool

	DeliveryTransport DeliveryTransport

	RelayEnabled        bool
	RelayPollInterval   time.Duration
	RelayBatchSize      int
	RelayAdvisoryLockID int64
	OutboxRetention     time.Duration

	JWTSecret          string
	JWTTTL             time.Duration
	DevLoginEnabled    bool
	WSAllowedOrigins   []string
	WSPingInterval     time.Duration
	WSPongTimeout      time.Duration
	WSSendBuffer       int
	WSMaxConnsPerUser  int
	WSMaxMessageBytes  int64
	RateLimitPerSecond int
	PresenceTTL        time.Duration
}

func Load() (Config, error) {
	c := Config{
		InstanceID: env("INSTANCE_ID", "gw-A"),
		HTTPAddr:   env("HTTP_ADDR", ":8080"),
		LogLevel:   env("LOG_LEVEL", "info"),

		PostgresDSN:      env("POSTGRES_DSN", "postgres://securechat:securechat@localhost:5432/securechat?sslmode=disable"),
		PostgresMaxConns: int32(envInt("POSTGRES_MAX_CONNS", 20)),

		RedisAddr:     env("REDIS_ADDR", "localhost:6379"),
		RedisPassword: env("REDIS_PASSWORD", ""),
		RedisDB:       envInt("REDIS_DB", 0),

		KafkaBrokers:         strings.Split(env("KAFKA_BROKERS", "localhost:9092"), ","),
		KafkaTopicMessages:   env("KAFKA_TOPIC_MESSAGES", "chat.messages"),
		KafkaTopicReceipts:   env("KAFKA_TOPIC_RECEIPTS", "chat.receipts"),
		KafkaTopicRetry:      env("KAFKA_TOPIC_RETRY", "chat.retry"),
		KafkaTopicDLQ:        env("KAFKA_TOPIC_DLQ", "chat.dlq"),
		KafkaConsumerGroup:   env("KAFKA_CONSUMER_GROUP", ""),
		KafkaStartFromLatest: envBool("KAFKA_START_FROM_LATEST", true),
		KafkaStaticMember:    envBool("KAFKA_STATIC_MEMBERSHIP", true),

		DeliveryTransport: DeliveryTransport(env("DELIVERY_TRANSPORT", string(TransportKafka))),

		RelayEnabled:        envBool("RELAY_ENABLED", true),
		RelayPollInterval:   envDuration("RELAY_POLL_INTERVAL", 100*time.Millisecond),
		RelayBatchSize:      envInt("RELAY_BATCH_SIZE", 200),
		RelayAdvisoryLockID: int64(envInt("RELAY_ADVISORY_LOCK_ID", 727001)),
		OutboxRetention:     envDuration("OUTBOX_RETENTION", 24*time.Hour),

		JWTSecret:          env("JWT_SECRET", ""),
		JWTTTL:             envDuration("JWT_TTL", 24*time.Hour),
		DevLoginEnabled:    envBool("AUTH_DEV_LOGIN_ENABLED", false),
		WSAllowedOrigins:   strings.Split(env("WS_ALLOWED_ORIGINS", "localhost:*"), ","),
		WSPingInterval:     envDuration("WS_PING_INTERVAL", 20*time.Second),
		WSPongTimeout:      envDuration("WS_PONG_TIMEOUT", 10*time.Second),
		WSSendBuffer:       envInt("WS_SEND_BUFFER", 256),
		WSMaxConnsPerUser:  envInt("WS_MAX_CONNS_PER_USER", 5),
		WSMaxMessageBytes:  int64(envInt("WS_MAX_MESSAGE_BYTES", 64*1024)),
		RateLimitPerSecond: envInt("RATE_LIMIT_PER_SECOND", 20),
		PresenceTTL:        envDuration("PRESENCE_TTL", 60*time.Second),
	}
	if c.KafkaConsumerGroup == "" {
		c.KafkaConsumerGroup = c.InstanceID
	}
	return c, c.validate()
}

func (c Config) validate() error {
	if len(c.JWTSecret) < 32 {
		return fmt.Errorf("JWT_SECRET must be set and at least 32 bytes")
	}
	switch c.DeliveryTransport {
	case TransportKafka, TransportRedis:
	default:
		return fmt.Errorf("DELIVERY_TRANSPORT must be kafka|redis, got %q", c.DeliveryTransport)
	}
	if c.InstanceID == "" {
		return fmt.Errorf("INSTANCE_ID must be set")
	}
	return nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, err := strconv.ParseBool(os.Getenv(key)); err == nil {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(key)); err == nil {
		return v
	}
	return def
}
