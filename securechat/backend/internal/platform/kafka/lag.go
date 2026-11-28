package kafka

import (
	"context"
	"log/slog"
	"time"

	"github.com/securechat/backend/internal/metrics"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// TopicLag is committed lag for one topic of one group, summed over partitions.
type TopicLag struct {
	Lag int64
	// Uncommitted counts partitions without a committed offset. They are not
	// added to Lag: a start-from-latest group never commits an idle partition,
	// and treating its retained history as lag would be misleading.
	Uncommitted int
}

// MeasureLag returns group → topic → lag via the admin API (KF9, INF4).
func MeasureLag(ctx context.Context, admin *kadm.Client, groups ...string) (map[string]map[string]TopicLag, error) {
	described, err := admin.Lag(ctx, groups...)
	if err != nil {
		return nil, err
	}
	out := make(map[string]map[string]TopicLag, len(described))
	for group, d := range described {
		if err := d.Error(); err != nil {
			return nil, err
		}
		topics := map[string]TopicLag{}
		for topic, parts := range d.Lag {
			var tl TopicLag
			for _, p := range parts {
				switch {
				case p.Err != nil || p.Commit.At < 0:
					tl.Uncommitted++
				case p.Lag > 0:
					tl.Lag += p.Lag
				}
			}
			topics[topic] = tl
		}
		out[group] = topics
	}
	return out, nil
}

// RunLagMonitor periodically exports MeasureLag into securechat_kafka_consumer_lag.
// It shares the consumer's client and is purely observational.
func RunLagMonitor(ctx context.Context, client *kgo.Client, every time.Duration, log *slog.Logger, groups ...string) {
	admin := kadm.NewClient(client)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		op, cancel := context.WithTimeout(ctx, every)
		lags, err := MeasureLag(op, admin, groups...)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			metrics.ConsumerLagErrors.Inc()
			log.Debug("consumer lag measurement failed", "err", err)
		}
		for group, topics := range lags {
			for topic, tl := range topics {
				metrics.ConsumerLag.WithLabelValues(group, topic).Set(float64(tl.Lag))
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
