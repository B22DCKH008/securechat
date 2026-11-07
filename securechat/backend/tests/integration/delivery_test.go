//go:build integration

// Integration tests run against the docker compose stack:
//
//	docker compose up -d && make test-integration
//
// Each test maps to a requirement / experiment ID from the engineering plan.
// Bodies are TODO for the team (start with a small HTTP/WS client helper).
package integration

import "testing"

func TestIdempotentRetryCreatesOneMessage(t *testing.T) {
	// RS1, RS2, RS37: send same clientMessageId N times concurrently → 1 row, same seq.
	t.Skip("TODO(BE1)")
}

func TestSeqIsGaplessUnderConcurrentWriters(t *testing.T) {
	// RS5, RS7, RS27: 2 instances × M goroutines into one conversation → seqs 1..N, no gaps/dups.
	t.Skip("TODO(BE1)")
}

func TestOfflineRecipientSyncsAfterReconnect(t *testing.T) {
	// RS3, RS4, SC3: Bob offline, Alice sends K messages, Bob connects → /v1/sync returns exactly K.
	t.Skip("TODO(BE1)")
}

func TestCrossInstanceDelivery(t *testing.T) {
	// RS13, EXP3: Alice on :8081, Bob on :8082 → Bob receives "message" frame via Kafka.
	t.Skip("TODO(BE2)")
}

func TestKafkaOutageBacklogDrains(t *testing.T) {
	// KF8, EXP12: docker compose stop kafka; send; assert accepted + outbox backlog > 0;
	// start kafka; assert backlog → 0 and no missing/duplicate on client side.
	t.Skip("TODO(BE1+BE2)")
}

func TestRelayCrashBetweenPublishAndMarkIsDeduped(t *testing.T) {
	// KF2, KF5: force re-publish of the same outbox row → client receives one message.
	t.Skip("TODO(BE1)")
}

func TestNonMemberCannotReadOrSend(t *testing.T) {
	// SC5
	t.Skip("TODO(BE1)")
}

func TestNoPlaintextInKafkaTopics(t *testing.T) {
	// SC7, KF12: send a known marker string as "ciphertext" after client encryption;
	// consume chat.messages from start and assert the PLAINTEXT marker never appears.
	t.Skip("TODO(FE1+BE2)")
}
