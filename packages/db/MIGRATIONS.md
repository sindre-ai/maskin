# Migration Conventions — Hot Tables

Postgres DDL takes locks. On tables on the hot path of an external webhook or another tight loop, the wrong DDL stalls writes long enough to time the upstream out. This file defines the lock-friendly recipes for the two patterns we have actually shipped into trouble: index creation and full-table backfills.

If you generated a migration with `pnpm db:generate`, walk the "Process — when you generate a migration" checklist at the bottom before opening the PR.

## Hot tables list

A table is "hot" when it is written to on the synchronous path of an external request the system cannot afford to stall. Any migration that touches one of these tables must follow the recipes below.

| Table | Why it's hot |
|-------|--------------|
| `webhook_deliveries` | Written on every Slack / integration webhook. The route holds the request open until the claim row commits. Lock contention here stalls every provider retry. |

When adding a table here, briefly note *why* it qualifies — the bar is "external caller will time out if writes block for more than a few seconds," not "it has a lot of rows."

## Rule 1 — Indexes on hot tables use `CONCURRENTLY`

Plain `CREATE INDEX` takes a `SHARE` lock for the duration of the build, which blocks every `INSERT` / `UPDATE` / `DELETE` against the table. `CREATE INDEX CONCURRENTLY` builds without blocking writes.

### How to write the migration

`CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block**. Our migrator uses `postgres.unsafe(...)` which runs each statement in autocommit mode (no implicit `BEGIN`/`COMMIT` wrapper), so technically CONCURRENTLY can coexist with other statements today — but keep it as the **only** statement in its migration file anyway. If another statement in the same file ever introduces an explicit `BEGIN`, the CONCURRENTLY silently errors or leaves an invalid index. Isolation eliminates that risk. No `ALTER TABLE`, no `UPDATE`, no second `CREATE INDEX`, no `--> statement-breakpoint`.

```sql
-- 00XX_webhook_deliveries_unprocessed_idx.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_unprocessed_received_at_idx"
	ON "webhook_deliveries" USING btree ("received_at")
	WHERE "processed_at" IS NULL;
```

`IF NOT EXISTS` matters: if a CONCURRENTLY build fails partway it leaves an `INVALID` index row that blocks a retry without it.

### Drizzle-kit generated migrations

`pnpm db:generate` emits plain `CREATE INDEX`. After generating, hand-edit the file to add `CONCURRENTLY` and `IF NOT EXISTS`, then split out any sibling statements per the rule above.

## Rule 2 — Backfills on hot tables are chunked

`UPDATE <hot_table> SET ...` with no `WHERE` rewrites every row in one transaction, holding row locks for the entire duration. On a hot table that means writes from the live path queue behind the migration.

### How to write the migration

Drive the backfill in chunks of ~5,000 rows, each in its own transaction, until no rows remain. PL/pgSQL `DO` blocks cannot issue `COMMIT` — only stored procedures can. Use `CREATE PROCEDURE` + `CALL` + `DROP PROCEDURE` so mid-loop commits work:

```sql
-- 00XX_backfill_webhook_deliveries_processed_at.sql
CREATE OR REPLACE PROCEDURE backfill_webhook_deliveries_processed_at()
LANGUAGE plpgsql AS $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS (
			SELECT id FROM webhook_deliveries
			WHERE processed_at IS NULL
			LIMIT 5000
			FOR UPDATE SKIP LOCKED
		)
		UPDATE webhook_deliveries d
		SET processed_at = d.received_at
		FROM batch
		WHERE d.id = batch.id;

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
		COMMIT;
	END LOOP;
END $$;

CALL backfill_webhook_deliveries_processed_at();

DROP PROCEDURE backfill_webhook_deliveries_processed_at();
```

`FOR UPDATE SKIP LOCKED` keeps the backfill out of the way of the live writer. Key the loop predicate on something that distinguishes backfilled rows (e.g. `WHERE processed_at IS NULL`) so a partial run can resume idempotently. The `DROP PROCEDURE` at the end cleans up — the procedure has no use after the migration runs.

For a one-off small backfill that the hot-tables threshold doesn't really need (e.g. the table has < 10k rows and 24h retention), call it out in a SQL comment and in the PR description rather than skipping the recipe silently. The next reviewer should not have to re-derive the call.

## Rule 3 — Constraint / column changes that rewrite the table

`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT <expr>` may take an `AccessExclusiveLock` for non-constant defaults, and `ALTER COLUMN ... TYPE` that can't use an implicit cast rewrites every row. On hot tables, split these:

1. Add the column nullable with no default.
2. Backfill it in chunks (Rule 2).
3. Set the default and / or `NOT NULL` in a separate migration once the backfill is done.

## Process — when you generate a migration

After `pnpm db:generate` produces a new `.sql`:

1. Open the file. Identify every table it writes to.
2. For each table in the hot-tables list above, check:
   - Any `CREATE INDEX` without `CONCURRENTLY`? → fix per Rule 1.
   - Any `UPDATE` without a bounded `WHERE` (or anything that rewrites every row)? → fix per Rule 2.
   - Any `ALTER TABLE` that adds a non-nullable column with a default, or changes a column type? → fix per Rule 3.
3. If a CONCURRENTLY index ends up alone in its file, that's correct — don't bundle for tidiness.
4. Mention the hot-table call in the PR description so the reviewer can verify the recipe was followed.

## History

- PR #498 shipped `0025_webhook_deliveries_processed_at.sql` with a plain `CREATE INDEX` and an unbounded `UPDATE webhook_deliveries SET processed_at = received_at`. Acceptable then because the table is 24h-retention and small in production, but a footgun for the next migration touching it. CTO follow-up raised the convention gap; this file is the answer.
