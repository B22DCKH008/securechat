#!/usr/bin/env bash
# Creates SecureChat topics (INF6, KF14). Idempotent.
# Single broker KRaft ⇒ replication-factor=1 ⇒ NO high availability (document in report).
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:9092}"
PARTITIONS="${KAFKA_PARTITIONS:-6}"
# Topics carry ciphertext: keep retention short (KF12). Team decides final value.
RETENTION_MS="${KAFKA_RETENTION_MS:-86400000}"   # 24h
KT=/opt/kafka/bin/kafka-topics.sh

echo "waiting for kafka at ${BOOTSTRAP}..."
until $KT --bootstrap-server "$BOOTSTRAP" --list >/dev/null 2>&1; do sleep 2; done

for t in chat.messages chat.receipts chat.retry chat.dlq; do
  ret="$RETENTION_MS"
  [[ "$t" == "chat.dlq" ]] && ret=$((RETENTION_MS * 7))   # keep poison events longer for investigation
  $KT --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
      --topic "$t" --partitions "$PARTITIONS" --replication-factor 1 \
      --config retention.ms="$ret" --config min.insync.replicas=1
done

$KT --bootstrap-server "$BOOTSTRAP" --describe
echo "topics ready"
