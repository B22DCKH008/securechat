# Experiments (doc §6)

Mỗi experiment một file `EXPxx-<tên>.md` theo mẫu dưới. Không đặt trước con số cam kết.

```
## EXPxx — <tên>
- Commit: <hash>   Máy: <CPU/RAM/OS>   Ngày:
- Cấu hình: #instances, VUs, duration, AI ON/OFF, env overrides
- Kịch bản / lệnh chạy:
- Metrics (bảng): throughput, p50/p95/p99, error rate, CPU/RAM, consumer lag, outbox backlog…
- Kết luận + giới hạn:
```

| ID | Bắt buộc | Công cụ / metric gợi ý |
|---|---|---|
| EXP1 baseline | MUST | `bench/k6/send_messages.js`, `securechat_send_accept_seconds` |
| EXP2 1 vs 2 instances | MUST | cùng script, BASE=8081 vs chia 8081/8082 |
| EXP3 cross-instance correctness | MUST | integration test |
| EXP4 offline/reconnect | MUST | đếm missing/duplicate theo seq |
| EXP5 reconnect storm | SHOULD | `bench/k6/reconnect_storm.js` |
| EXP6 DB/index/pagination | SHOULD | `EXPLAIN ANALYZE` cursor vs offset |
| EXP11 latency breakdown | MUST | `securechat_stage_accepted_to_{published,consumed,pushed}_seconds` |
| EXP12 Kafka outage | MUST | `docker compose stop kafka` → `securechat_outbox_backlog` |
| EXP13 Redis vs Kafka | EXPERIMENT | `DELIVERY_TRANSPORT=redis` (cần làm Redis publisher) |
| EXP8/9 AI | MUST | `ml/reports/` |
