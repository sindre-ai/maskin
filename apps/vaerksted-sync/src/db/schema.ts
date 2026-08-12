import { bigint, bigserial, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// vaerksted-sync's own schema — design doc §9 ("Sync protocol") and the
// implementation plan's M4 section. This app has zero code-level dependency
// on `packages/db` (Maskin's own schema) or on `apps/vaerksted-auth`'s
// schema, per design doc §4 — it lives in its own database/migration folder
// (`apps/vaerksted-sync/drizzle/`), never `packages/db/drizzle/` or
// `apps/vaerksted-auth/drizzle/`.
//
// Neither table below has an FK constraint. `device_id`/`identity_id` on
// `sync_blob` are cross-service references into vaerksted-auth's schema (a
// different logical database/schema entirely) — same reasoning as the
// FK-less `actors.vaerksted_identity_id` column added by M5, see that
// migration's comment. `consumed_nonce` has no relationships at all.

// ── Sync blob ───────────────────────────────────────────────────────────────
//
// Per-field last-write-wins sync record (design doc §9: "Proposal: per-field
// last-write-wins, keyed by (device_id, logical_clock)"). One row per
// (meeting, field) write from a device — NOT one row per meeting. The server
// never interprets `logical_clock`; it exists purely for the client's own LWW
// conflict resolution. `server_seq` is the server-assigned global monotonic
// sequence GET /sync/pull?since= paginates on — deliberately distinct from
// `logical_clock`.
export const syncBlob = pgTable('sync_blob', {
	id: uuid('id').defaultRandom().primaryKey(),
	// From the verified device cert (device-cert-middleware.ts's context),
	// never client-supplied in the request body.
	deviceId: uuid('device_id').notNull(),
	// From the verified device cert. Pull reads span every device belonging to
	// this identity, not just the caller's own device.
	identityId: uuid('identity_id').notNull(),
	// Skjald's opaque meeting id — NOT assumed to be a strict uuid (Skjald's
	// local id scheme is its own concern, not this service's).
	meetingId: text('meeting_id').notNull(),
	// e.g. 'title', 'notes', 'tags' — opaque string, this server does not
	// validate against a fixed enum (that's a Skjald-side concept, and new
	// fields shouldn't require a vaerksted-sync migration).
	field: text('field').notNull(),
	// CLIENT-assigned, per-device monotonic counter — used ONLY for the
	// client's own LWW conflict resolution. The server never reads this value
	// for its own ordering; that's `server_seq`'s job. Stored as `mode:
	// 'number'` (not 'bigint') so it round-trips through JSON responses
	// without BigInt-serialization handling — acceptable here since a
	// per-device monotonic counter realistically never approaches
	// Number.MAX_SAFE_INTEGER (2^53) in this service's lifetime.
	logicalClock: bigint('logical_clock', { mode: 'number' }).notNull(),
	// The field's new value, always a string — encoding is the client's
	// responsibility (design doc's exact wire contract).
	payload: text('payload').notNull(),
	// SERVER-assigned global monotonic sequence — what GET /sync/pull?since=
	// paginates on. `bigserial` already implies NOT NULL; `.unique()` adds the
	// explicit unique index the design doc calls for (this is not the primary
	// key — `id` is). Same `mode: 'number'` tradeoff as `logicalClock` above.
	serverSeq: bigserial('server_seq', { mode: 'number' }).notNull().unique(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SyncBlob = typeof syncBlob.$inferSelect
export type NewSyncBlob = typeof syncBlob.$inferInsert

// ── Consumed nonce ──────────────────────────────────────────────────────────
//
// Real nonce single-use tracking — deferred by vaerksted-auth's
// `challenge.ts` ("a relay-level (vaerksted-sync, M4) concern") to here.
// device-cert-middleware.ts inserts the nonce on first use; a primary-key
// conflict on this table means the nonce was already consumed (replay) and
// the request is rejected with 401. See that middleware for the retention/
// cleanup strategy.
export const consumedNonce = pgTable('consumed_nonce', {
	nonce: text('nonce').primaryKey(),
	consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ConsumedNonce = typeof consumedNonce.$inferSelect
export type NewConsumedNonce = typeof consumedNonce.$inferInsert
