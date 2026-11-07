// Package kafka builds franz-go clients with the reliability settings required by KF3.
package kafka

import (
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// NewProducer: acks=all + idempotent producer (franz-go enables idempotency by
// default when acks=all). MVP does NOT use exactly-once transactions (doc §9).
func NewProducer(brokers []string, clientID string) (*kgo.Client, error) {
	return kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ClientID(clientID),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.ProducerLinger(5*time.Millisecond),
		kgo.RecordDeliveryTimeout(10*time.Second), // bounded so the relay can back off (KF8)
		kgo.ProduceRequestTimeout(5*time.Second),
		kgo.RecordPartitioner(kgo.StickyKeyPartitioner(nil)), // key = conversationId (KF4)
		kgo.AllowAutoTopicCreation(),                         // topics are created by deploy/kafka/create-topics.sh; this is a dev fallback
	)
}

// NewGatewayConsumer: one consumer group PER INSTANCE (gw-A, gw-B) so every
// instance sees every event (KF7 broadcast model). Offsets are committed manually
// after processing (KF6). InstanceID enables static membership (KF10).
func NewGatewayConsumer(brokers []string, group string, startLatest, staticMembership bool, topics ...string) (*kgo.Client, error) {
	reset := kgo.NewOffset().AtStart()
	if startLatest {
		// A brand-new group only needs live events; history comes from PostgreSQL sync.
		reset = kgo.NewOffset().AtEnd()
	}
	opts := []kgo.Opt{
		kgo.SeedBrokers(brokers...),
		kgo.ClientID(group),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topics...),
		kgo.ConsumeResetOffset(reset),
		kgo.DisableAutoCommit(),
		kgo.FetchMaxWait(250 * time.Millisecond),
	}
	if staticMembership {
		// Restarting with the same id avoids a full rebalance (KF10).
		opts = append(opts, kgo.InstanceID(group))
	}
	return kgo.NewClient(opts...)
}
