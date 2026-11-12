// Command dbbench measures DB/service behavior in a disposable schema.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/service/messaging"
	"github.com/securechat/backend/internal/store"
)

type stats struct {
	Samples int     `json:"samples"`
	P50     float64 `json:"p50Ms"`
	P95     float64 `json:"p95Ms"`
	P99     float64 `json:"p99Ms"`
}
type result struct {
	Kind                string          `json:"kind"`
	SeedMessages        int             `json:"seedMessages"`
	Offset              int             `json:"offset,omitempty"`
	Workers             int             `json:"workers,omitempty"`
	Round               int             `json:"round"`
	Latency             stats           `json:"latency"`
	OperationsPerSecond float64         `json:"operationsPerSecond"`
	Plan                json.RawMessage `json:"plan,omitempty"`
}
type report struct {
	At                     time.Time `json:"at"`
	Go, OS, PostgreSQL     string
	PayloadBytes, PageSize int
	Results                []result
	Verified               bool   `json:"verified"`
	Notes                  string `json:"notes"`
	SourceSHA256           string `json:"sourceSHA256"`
}

func summarize(values []float64) stats {
	sort.Float64s(values)
	pick := func(p float64) float64 { return values[int(float64(len(values)-1)*p)] }
	return stats{len(values), pick(.5), pick(.95), pick(.99)}
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	countsFlag := flag.String("counts", "1000,10000", "seed sizes")
	samples := flag.Int("samples", 100, "measured queries per round")
	rounds := flag.Int("rounds", 3, "rounds per scenario")
	sendOps := flag.Int("send-ops", 200, "measured sends per worker configuration per round")
	output := flag.String("out", "", "JSON output file, otherwise stdout")
	flag.Parse()
	if *samples < 10 || *samples > 10000 || *rounds < 1 || *rounds > 10 || *sendOps < 10 || *sendOps > 10000 {
		return fmt.Errorf("invalid benchmark size")
	}
	var counts []int
	for _, value := range strings.Split(*countsFlag, ",") {
		n, e := strconv.Atoi(value)
		if e != nil || n < 100 || n > 1000000 {
			return fmt.Errorf("invalid seed count")
		}
		counts = append(counts, n)
	}
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		dsn = "postgres://securechat:securechat@localhost:5432/securechat?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	admin, e := pgx.Connect(ctx, dsn)
	if e != nil {
		return e
	}
	defer admin.Close(context.Background())
	rep := report{At: time.Now().UTC(), Go: runtime.Version(), OS: runtime.GOOS + "/" + runtime.GOARCH, PayloadBytes: 256, PageSize: 50, Notes: "Local DB/service only; seeded rows bypass send/outbox; measured sends use the real service. No Kafka, HTTP, Signal or system-capacity claim."}
	rep.SourceSHA256, e = sourceDigest()
	if e != nil {
		return e
	}
	if e = admin.QueryRow(ctx, "SELECT version()").Scan(&rep.PostgreSQL); e != nil {
		return e
	}
	for _, count := range counts {
		results, e := measure(ctx, admin, dsn, count, *samples, *rounds, *sendOps)
		if e != nil {
			return e
		}
		rep.Results = append(rep.Results, results...)
	}
	rep.Verified = true
	writer := os.Stdout
	if *output != "" {
		if e = os.MkdirAll(filepath.Dir(*output), 0755); e != nil {
			return e
		}
		writer, e = os.Create(*output)
		if e != nil {
			return e
		}
		defer writer.Close()
	}
	enc := json.NewEncoder(writer)
	enc.SetIndent("", "  ")
	return enc.Encode(rep)
}
func measure(ctx context.Context, admin *pgx.Conn, dsn string, count, samples, rounds, sendOps int) (results []result, retErr error) {
	schema := "bench_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, e := admin.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		return nil, e
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, e := admin.Exec(cleanup, "DROP SCHEMA "+schema+" CASCADE"); e != nil && retErr == nil {
			retErr = e
		}
	}()
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		return nil, e
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 8
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		return nil, e
	}
	defer pool.Close()
	migrations, e := filepath.Glob("migrations/*.up.sql")
	if e != nil || len(migrations) == 0 {
		return nil, fmt.Errorf("run from backend directory with migrations available")
	}
	sort.Strings(migrations)
	for _, file := range migrations {
		raw, e := os.ReadFile(file)
		if e != nil {
			return nil, e
		}
		if _, e = pool.Exec(ctx, string(raw)); e != nil {
			return nil, e
		}
	}
	a, b := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{a, b} {
		if _, e = pool.Exec(ctx, `INSERT INTO users(id,username)VALUES($1,$2)`, id, id.String()); e != nil {
			return nil, e
		}
	}
	service := messaging.New(pool, messaging.Topics{Messages: "chat.messages", Receipts: "chat.receipts"}, 65536)
	conversation, e := service.CreateDirect(ctx, a, b)
	if e != nil {
		return nil, e
	}
	conv := conversation.ID
	payload := bytes.Repeat([]byte{42}, 256)
	_, e = pool.Exec(ctx, `INSERT INTO messages(id,conversation_id,seq,sender_id,client_message_id,ciphertext)
  SELECT gen_random_uuid(),$1,n,$2,'seed-'||n,$3 FROM generate_series(1,$4::int)n`, conv, a, payload, count)
	if e != nil {
		return nil, e
	}
	if _, e = pool.Exec(ctx, `UPDATE conversations SET last_seq=$2 WHERE id=$1`, conv, count); e != nil {
		return nil, e
	}
	if _, e = pool.Exec(ctx, `ANALYZE messages`); e != nil {
		return nil, e
	}
	for _, kind := range []string{"keyset", "offset"} {
		query := `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,client_message_id,conversation_id,seq,sender_id,ciphertext,protocol_meta,client_created_at,created_at FROM messages WHERE conversation_id=$1 `
		var parameter int
		if kind == "keyset" {
			query += `AND seq<$2 ORDER BY seq DESC LIMIT 50`
			parameter = 51
		} else {
			query += `ORDER BY seq DESC LIMIT 50 OFFSET $2`
			parameter = count - 50
		}
		var plan json.RawMessage
		if e = pool.QueryRow(ctx, query, conv, parameter).Scan(&plan); e != nil {
			return nil, e
		}
		results = append(results, result{Kind: "plan_" + kind, SeedMessages: count, Offset: count - 50, Plan: plan})
	}
	for _, offset := range []int{0, count / 2, count - 50} {
		anchor := int64(count - offset + 1)
		query := func(kind string) error {
			var seqs []int64
			if kind == "keyset" {
				messages, e := store.MessagesBefore(ctx, pool, conv, anchor, 50)
				if e != nil {
					return e
				}
				for _, m := range messages {
					seqs = append(seqs, m.Seq)
				}
			} else {
				rows, e := pool.Query(ctx, `SELECT id,client_message_id,conversation_id,seq,sender_id,ciphertext,protocol_meta,client_created_at,created_at FROM messages WHERE conversation_id=$1 ORDER BY seq DESC LIMIT 50 OFFSET $2`, conv, offset)
				if e != nil {
					return e
				}
				defer rows.Close()
				for rows.Next() {
					var m domain.Message
					if e = rows.Scan(&m.ID, &m.ClientMessageID, &m.ConversationID, &m.Seq, &m.SenderID, &m.Ciphertext, &m.ProtocolMeta, &m.ClientCreatedAt, &m.CreatedAt); e != nil {
						return e
					}
					seqs = append(seqs, m.Seq)
				}
				if e = rows.Err(); e != nil {
					return e
				}
			}
			if len(seqs) != 50 {
				return fmt.Errorf("short page")
			}
			for i, seq := range seqs {
				if seq != anchor-1-int64(i) {
					return fmt.Errorf("page mismatch")
				}
			}
			return nil
		}
		for round := 1; round <= rounds; round++ {
			kinds := []string{"keyset", "offset"}
			if round%2 == 0 {
				kinds = []string{"offset", "keyset"}
			}
			for _, kind := range kinds {
				for range 5 {
					if e = query(kind); e != nil {
						return nil, e
					}
				}
				values := make([]float64, 0, samples)
				started := time.Now()
				for range samples {
					at := time.Now()
					if e = query(kind); e != nil {
						return nil, e
					}
					values = append(values, float64(time.Since(at).Microseconds())/1000)
				}
				results = append(results, result{Kind: kind, SeedMessages: count, Offset: offset, Round: round, Latency: summarize(values), OperationsPerSecond: float64(samples) / time.Since(started).Seconds()})
			}
		}
	}
	accepted := int64(0)
	for _, workers := range []int{1, 4} {
		for round := 1; round <= rounds; round++ {
			var next atomic.Int64
			values := make(chan float64, sendOps)
			errs := make(chan error, workers)
			var wg sync.WaitGroup
			started := time.Now()
			for range workers {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for {
						i := next.Add(1)
						if i > int64(sendOps) {
							return
						}
						at := time.Now()
						_, e := service.Send(ctx, domain.SendCommand{SenderID: a, ConversationID: conv, ClientMessageID: uuid.NewString(), Ciphertext: payload})
						if e != nil {
							errs <- e
							return
						}
						values <- float64(time.Since(at).Microseconds()) / 1000
					}
				}()
			}
			wg.Wait()
			elapsed := time.Since(started)
			close(errs)
			for e := range errs {
				if e != nil {
					return nil, e
				}
			}
			close(values)
			latencies := make([]float64, 0, sendOps)
			for n := range values {
				latencies = append(latencies, n)
			}
			if len(latencies) != sendOps {
				return nil, fmt.Errorf("missing measured sends")
			}
			accepted += int64(sendOps)
			results = append(results, result{Kind: "send_hot_conversation", SeedMessages: count, Workers: workers, Round: round, Latency: summarize(latencies), OperationsPerSecond: float64(sendOps) / elapsed.Seconds()})
		}
	}
	var total, seq, unique, outboxes int64
	if e = pool.QueryRow(ctx, `SELECT count(*),count(DISTINCT seq) FROM messages`).Scan(&total, &unique); e != nil {
		return nil, e
	}
	if e = pool.QueryRow(ctx, `SELECT last_seq FROM conversations WHERE id=$1`, conv).Scan(&seq); e != nil {
		return nil, e
	}
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM outbox`).Scan(&outboxes); e != nil {
		return nil, e
	}
	if total != int64(count)+accepted || seq != total || unique != total || outboxes != accepted {
		return nil, fmt.Errorf("count/sequence/outbox verification failed")
	}
	return results, nil
}

func sourceDigest() (string, error) {
	var paths []string
	err := filepath.WalkDir(".", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".go") || strings.HasSuffix(path, ".sql") || path == "go.mod" || path == "go.sum" {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		hash.Write([]byte(filepath.ToSlash(path)))
		hash.Write([]byte{0})
		hash.Write(raw)
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
