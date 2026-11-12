.PHONY: help up down logs ps build test test-integration lint fmt migrate-up migrate-down kafka-topics scan-plaintext bench

help:            ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-18s %s\n",$$1,$$2}'

.env:
	cp .env.example .env

up: .env         ## Start full stack (2 backends, Postgres, Redis, Kafka)
	docker compose up -d --build

down:            ## Stop stack
	docker compose down

logs:            ## Tail backend logs
	docker compose logs -f backend-a backend-b

ps:
	docker compose ps

build:           ## Build backend binary
	cd backend && go build ./...

test:            ## Unit tests
	cd backend && go test ./...

test-integration: .env ## Real PostgreSQL/Kafka tests with Linux race detector
	docker compose -f docker-compose.yml -f compose.test.yml run --rm be1-test

lint:
	cd backend && go vet ./... && gofmt -l .

fmt:
	cd backend && gofmt -w .

migrate-up:
	docker compose run --rm migrate

migrate-down:
	docker compose run --rm migrate -path=/migrations -database=postgres://securechat:securechat@postgres:5432/securechat?sslmode=disable down 1

kafka-topics:    ## Describe Kafka topics
	docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --describe

scan-plaintext:  ## SC7: grep DB / Kafka / logs for a known plaintext marker (MARKER=...)
	./scripts/scan-plaintext.sh "$(MARKER)"

bench:           ## k6 baseline (EXP1)
	k6 run bench/k6/send_messages.js
