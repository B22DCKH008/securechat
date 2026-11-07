#!/usr/bin/env bash
# SC7 / KF12 / INF3: search every server-side store for a known PLAINTEXT marker.
# Usage: send a message whose plaintext contains MARKER from the real E2EE client,
#        then run: ./scripts/scan-plaintext.sh MARKER
# Expected result: 0 hits everywhere. Save the output as evidence for the security checklist.
set -uo pipefail
M="${1:?usage: scan-plaintext.sh <marker>}"
fail=0
check() { local name="$1" hits="$2"; printf "%-28s %s\n" "$name" "$hits"; [[ "$hits" != "0" ]] && fail=1; }

check "postgres.messages"  "$(docker compose exec -T postgres psql -U securechat -tAc "select count(*) from messages where convert_from(ciphertext,'LATIN1') ilike '%$M%'" | tr -d '[:space:]')"
check "postgres.outbox"    "$(docker compose exec -T postgres psql -U securechat -tAc "select count(*) from outbox where payload::text ilike '%$M%'" | tr -d '[:space:]')"
check "redis (all keys)"   "$(docker compose exec -T redis sh -c "redis-cli --scan | xargs -r -n1 redis-cli dump 2>/dev/null | grep -c '$M'" | tr -d '[:space:]')"
for t in chat.messages chat.receipts chat.retry chat.dlq; do
  check "kafka.$t" "$(docker compose exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --topic $t --from-beginning --timeout-ms 5000 2>/dev/null | grep -c "$M")"
done
check "backend logs"       "$(docker compose logs backend-a backend-b 2>/dev/null | grep -c "$M")"
# TODO(FE1): capture network traffic (browser devtools HAR / tcpdump) and grep it too.
exit $fail
