// Package metrics exposes Prometheus metrics (INF4, EXP11).
// Labels must never contain user content or ids with high cardinality.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var latencyBuckets = []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}

var (
	MessagesAccepted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_messages_accepted_total", Help: "Messages committed to PostgreSQL."})
	MessagesDuplicate = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_messages_duplicate_total", Help: "Idempotent retries returning an existing message (RS2)."})
	SendLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "securechat_send_accept_seconds", Help: "Server time from receive to server-accepted ACK.", Buckets: latencyBuckets})

	OutboxBacklog = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "securechat_outbox_backlog", Help: "Unpublished outbox rows (EXP12)."})
	OutboxPublished = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_outbox_published_total", Help: "Outbox rows acked by Kafka."})
	OutboxPublishErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_outbox_publish_errors_total", Help: "Failed publish attempts."})
	RelayLeader = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "securechat_outbox_relay_leader", Help: "1 if this instance holds the relay advisory lock."})

	// EXP11 latency breakdown: accepted → published → consumed → pushed.
	StageAcceptedToPublished = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "securechat_stage_accepted_to_published_seconds", Buckets: latencyBuckets})
	StageAcceptedToConsumed = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "securechat_stage_accepted_to_consumed_seconds", Buckets: latencyBuckets})
	StageAcceptedToPushed = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "securechat_stage_accepted_to_pushed_seconds", Buckets: latencyBuckets})

	EventsConsumed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "securechat_delivery_events_consumed_total"}, []string{"topic"})
	EventsDeduped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_delivery_events_deduped_total", Help: "At-least-once duplicates dropped (KF5)."})
	EventsDLQ = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_delivery_events_dlq_total", Help: "Poison events sent to DLQ (KF11)."})

	WSConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "securechat_ws_connections", Help: "Open WebSocket connections on this instance."})
	WSPushed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_ws_frames_pushed_total"})
	WSSlowConsumerDrops = promauto.NewCounter(prometheus.CounterOpts{
		Name: "securechat_ws_slow_consumer_closed_total", Help: "Connections closed because send buffer was full (RS17/RS18)."})
	RateLimited = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "securechat_rate_limited_total"}, []string{"scope"})

	// TODO(BE2, INF4/KF9): consumer lag. Either add a kafka-exporter container to
	// docker-compose, or compute lag with github.com/twmb/franz-go/pkg/kadm.
)
