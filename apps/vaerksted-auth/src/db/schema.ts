import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// vaerksted-auth's own schema — design doc §5 ("Identity model"). This app
// has zero code-level dependency on `packages/db` (Maskin's own schema) per
// design doc §4; the three tables below are the entirety of vaerksted-auth's
// data model and live in their own database/migration folder
// (`apps/vaerksted-auth/drizzle/`), never `packages/db/drizzle/`.
//
// Unlike the cross-service `actors.vaerksted_identity_id` link that M5 adds
// to Maskin's own `actors` table (deliberately NOT an FK — see that
// migration's comment), the three tables here live in the same
// service/database and DO use real FK constraints between each other.

// ── Identity ────────────────────────────────────────────────────────────────

export const vaerkstedIdentity = pgTable('vaerksted_identity', {
	id: uuid('id').defaultRandom().primaryKey(),
	// Maps to Supabase Auth's `auth.users.id`, which is itself a uuid. Kept as
	// its own column rather than reused as this table's primary key — see
	// design doc §5's note on why `vaerksted_identity.id` is intentionally our
	// own generated UUID, not Supabase's.
	supabaseUserId: uuid('supabase_user_id').notNull().unique(),
	// Nullable — an identity can exist before any email is attached (design doc §5).
	email: text('email'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type VaerkstedIdentity = typeof vaerkstedIdentity.$inferSelect
export type NewVaerkstedIdentity = typeof vaerkstedIdentity.$inferInsert

// ── Device ──────────────────────────────────────────────────────────────────

export const device = pgTable('device', {
	id: uuid('id').defaultRandom().primaryKey(),
	// Nullable — set only once sync is enabled and the device is linked to an
	// identity (design doc §5, §7's `LocalOnly` → `SyncedSingleDevice` step).
	identityId: uuid('identity_id').references(() => vaerkstedIdentity.id),
	// Ed25519 public key, generated on-device — the private key never leaves
	// the device (design doc §6 step 1). Hex-encoded per
	// `@maskin/vaerksted-crypto`'s encoding convention.
	publicKey: text('public_key').notNull().unique(),
	// 'macos' | 'ios' | ... today; deliberately generic (not `human_device`) so
	// an agent principal can later be represented as `platform: 'agent'`
	// (design doc §5, M6 territory — not built here).
	platform: text('platform').notNull(),
	displayName: text('display_name'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export type Device = typeof device.$inferSelect
export type NewDevice = typeof device.$inferInsert

// ── Device Certificate ──────────────────────────────────────────────────────

export const deviceCert = pgTable('device_cert', {
	// Design doc §5 doesn't specify a primary key for device_cert explicitly —
	// adding one here, consistent with every other table's `uuid().defaultRandom()`
	// convention (see `packages/db/src/schema.ts`).
	id: uuid('id').defaultRandom().primaryKey(),
	deviceId: uuid('device_id')
		.notNull()
		.references(() => device.id),
	identityId: uuid('identity_id')
		.notNull()
		.references(() => vaerkstedIdentity.id),
	issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
	// Short TTL (design doc §6 proposes 24h) — revocation propagates by
	// non-renewal, not by push.
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	// vaerksted-auth's signature over (device_id, identity_id, public_key,
	// expires_at) — see `@maskin/vaerksted-crypto`'s `issueCert`/`verifyCert`.
	signature: text('signature').notNull(),
})

export type DeviceCert = typeof deviceCert.$inferSelect
export type NewDeviceCert = typeof deviceCert.$inferInsert
