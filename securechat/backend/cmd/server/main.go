// Command server runs one SecureChat backend instance:
// REST API + WebSocket gateway + gateway Kafka consumer + (leader-elected) outbox relay.
//
// Run two instances with different INSTANCE_ID (gw-A, gw-B) to test cross-instance routing.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/config"
	"github.com/securechat/backend/internal/delivery"
	"github.com/securechat/backend/internal/gateway"
	"github.com/securechat/backend/internal/httpapi"
	"github.com/securechat/backend/internal/logger"
	"github.com/securechat/backend/internal/outbox"
	"github.com/securechat/backend/internal/platform/kafka"
	"github.com/securechat/backend/internal/platform/postgres"
	"github.com/securechat/backend/internal/presence"
	"github.com/securechat/backend/internal/ratelimit"
	"github.com/securechat/backend/internal/service/keys"
	"github.com/securechat/backend/internal/service/messaging"
	"github.com/securechat/backend/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	log := logger.New(cfg.LogLevel).With("instance", cfg.InstanceID)
	if err := run(cfg, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- infrastructure ---
	pool, err := postgres.NewPool(ctx, cfg.PostgresDSN, cfg.PostgresMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()

	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr, Password: cfg.RedisPassword, DB: cfg.RedisDB})
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		// Redis is not on the durable path: start degraded rather than refuse (RS39).
		log.Warn("redis unavailable at startup; presence/rate-limit degraded", "err", err)
	}

	producer, err := kafka.NewProducer(cfg.KafkaBrokers, cfg.InstanceID+"-producer")
	if err != nil {
		return err
	}
	defer producer.Close()

	// --- services ---
	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTTTL)
	authSvc, err := auth.NewService(pool, issuer, cfg.DevLoginEnabled)
	if err != nil {
		return err
	}
	msgSvc := messaging.New(pool, messaging.Topics{Messages: cfg.KafkaTopicMessages, Receipts: cfg.KafkaTopicReceipts}, int(cfg.WSMaxMessageBytes))
	keySvc := keys.New(pool)
	limiter := ratelimit.New(rdb, cfg.RateLimitPerSecond, log)
	registry := presence.NewRegistry(rdb, cfg.InstanceID, cfg.PresenceTTL)

	hub := gateway.NewHub(cfg.WSMaxConnsPerUser)
	wsHandler := gateway.NewHandler(hub, msgSvc, registry, limiter, authSvc, gateway.Options{
		AllowedOrigins: cfg.WSAllowedOrigins,
		PingInterval:   cfg.WSPingInterval,
		PongTimeout:    cfg.WSPongTimeout,
		SendBuffer:     cfg.WSSendBuffer,
		MaxFrameBytes:  cfg.WSMaxFrameBytes,
	}, log)

	var devLogin func(context.Context, string) (uuid.UUID, error)
	if cfg.DevLoginEnabled {
		log.Warn("AUTH_DEV_LOGIN_ENABLED=true – never enable in production")
		devLogin = func(ctx context.Context, username string) (uuid.UUID, error) {
			u, err := store.UpsertUser(ctx, pool, username)
			return u.ID, err
		}
	}

	router := httpapi.NewRouter(httpapi.Deps{
		Messaging: msgSvc, Keys: keySvc, Auth: authSvc, Limiter: limiter, WS: wsHandler,
		DevLogin: devLogin, Log: log, InstanceID: cfg.InstanceID,
		Ready: func(ctx context.Context) error { return pool.Ping(ctx) }, // Kafka/Redis are not required for readiness (KF8)
	})

	// --- background workers ---
	var wg sync.WaitGroup
	bg, cancelBG := context.WithCancel(context.Background())
	defer cancelBG()

	deliveryRouter := delivery.NewRouter(hub, 100_000)
	switch cfg.DeliveryTransport {
	case config.TransportKafka:
		consumer, err := kafka.NewGatewayConsumer(cfg.KafkaBrokers, cfg.KafkaConsumerGroup, cfg.KafkaStartFromLatest, cfg.KafkaStaticMember,
			cfg.KafkaTopicMessages, cfg.KafkaTopicReceipts)
		if err != nil {
			return err
		}
		defer consumer.Close()
		kc := delivery.NewKafkaConsumer(consumer, producer, deliveryRouter, cfg.KafkaTopicDLQ, log)
		wg.Add(1)
		go func() { defer wg.Done(); kc.Run(bg) }()
	case config.TransportRedis:
		log.Warn("DELIVERY_TRANSPORT=redis (experiment mode, non-durable realtime path)")
		sub := delivery.NewRedisSubscriber(rdb, deliveryRouter, log, cfg.KafkaTopicMessages, cfg.KafkaTopicReceipts)
		wg.Add(1)
		go func() { defer wg.Done(); sub.Run(bg) }()
		// TODO(BE2, KF16): relay must publish to Redis too in this mode.
	}

	if cfg.RelayEnabled {
		relay := outbox.NewRelay(pool, producer, outbox.Config{
			PollInterval: cfg.RelayPollInterval, BatchSize: cfg.RelayBatchSize,
			LockID: cfg.RelayAdvisoryLockID, Retention: cfg.OutboxRetention,
		}, log)
		wg.Add(1)
		go func() { defer wg.Done(); relay.Run(bg) }()
	}

	// --- HTTP ---
	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: router, ReadHeaderTimeout: 5 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.HTTPAddr, "transport", cfg.DeliveryTransport)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-errCh:
		return err
	}

	// --- graceful shutdown (RS29): close WS so clients reconnect elsewhere and resync ---
	log.Info("shutting down")
	hub.CloseAll("server shutting down")
	shCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shCtx)
	cancelBG()
	wg.Wait()
	return nil
}
