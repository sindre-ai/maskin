-- Outbound-side idempotency ledger backing the API's `Idempotency-Key`
-- header. Replaces the previous in-memory cache so that a session snapshot
-- + replay produces the same cached response instead of double-firing
-- side effects (the load-bearing primitive for the queue+snapshot+retry
-- work in the session-infra-scale bet — see T10).
--
-- `key` is `{actorId|anon}:{idempotency-key-header}`. Anonymous calls
-- (signup) carry NULL actor_id. `created_at` drives a 24h sliding TTL,
-- cleaned up out-of-band; the cleaner job pattern mirrors
-- webhook_deliveries_cleaner.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "idempotency_records" (
	"key" text PRIMARY KEY,
	"actor_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idempotency_records_created_at_idx"
	ON "idempotency_records" ("created_at");
