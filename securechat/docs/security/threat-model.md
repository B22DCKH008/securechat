# Threat model (SC8) — TEMPLATE, cả nhóm điền ở tuần 4

## Assets
- Plaintext message, private keys (client only) · ciphertext + metadata (server) · JWT

## Adversaries
| Adversary | Có thể | Không thể (theo thiết kế) |
|---|---|---|
| Server operator / DB dump | đọc metadata, ciphertext | đọc plaintext |
| Network attacker | (TODO: TLS ở production) | |
| Kafka/Redis access | đọc ciphertext event, presence | đọc plaintext |
| Endpoint bị xâm nhập | đọc mọi thứ trên thiết bị | — E2EE không bảo vệ trường hợp này |

## Mitigations / Gaps
- TODO
