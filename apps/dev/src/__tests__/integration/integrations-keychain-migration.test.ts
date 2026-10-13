import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { describe, expect, it } from 'vitest'
import {
	CREDENTIAL_LOG_GENESIS_HASH,
	CREDENTIAL_LOG_ROLE,
	computeRowHash,
	verifyCredentialAccessChain,
} from '../../lib/integrations/credential-audit'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(migrationsDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) await tx.unsafe(statement)
	})
}

const UP = '0087_keychain_core.sql'
const DOWN = 'down/0087_keychain_core_down.sql'
// 0089's index has a predicate on provider_mode, so dropping that column (0087 down)
// drops the index with it. Roll back newest first: 0089 down before 0087 down.
const UP_0089 = '0089_integrations_null_external_uniq_skip_byo.sql'
const DOWN_0089 = 'down/0089_integrations_null_external_uniq_skip_byo_down.sql'

async function columns(table: string) {
	const rows = await sql<
		{ column_name: string; is_nullable: string; column_default: string | null }[]
	>`
		SELECT column_name, is_nullable, column_default FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = ${table}
	`
	return new Map(rows.map((r) => [r.column_name, r]))
}

async function indexNames(table: string) {
	const rows = await sql<{ indexname: string }[]>`
		SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}
	`
	return rows.map((r) => r.indexname)
}

async function newIntegration(overrides: Record<string, unknown> = {}) {
	const createdBy = getTestActorId()
	const ws = await insertWorkspace(db, createdBy)
	const row = {
		workspace_id: ws.id,
		provider: 'fake-provider',
		status: 'active',
		credentials: 'fake-ciphertext',
		created_by: createdBy,
		...overrides,
	}
	return { ws, row }
}

describe('integrations Keychain columns (0087)', () => {
	it('adds every column with the specified default', async () => {
		const cols = await columns('integrations')
		expect(cols.get('provider_mode')?.column_default).toContain('registered')
		expect(cols.get('provider_mode')?.is_nullable).toBe('NO')
		expect(cols.get('display_name')?.is_nullable).toBe('YES')
		expect(cols.get('scope_grants')?.column_default).toContain("'[]'")
		expect(cols.get('scope_grants')?.is_nullable).toBe('NO')
		expect(cols.get('dek_ciphertext')?.is_nullable).toBe('YES')
		expect(cols.get('source')?.column_default).toContain('admin_ui')
		expect(cols.get('origin_session_id')?.is_nullable).toBe('YES')
		expect(cols.get('undo_expires_at')?.is_nullable).toBe('YES')
	})

	it('creates the mode index and the partial sweeper index', async () => {
		const names = await indexNames('integrations')
		expect(names).toContain('integrations_ws_mode_idx')
		expect(names).toContain('integrations_undo_sweeper_idx')
		const [def] = await sql<{ indexdef: string }[]>`
			SELECT indexdef FROM pg_indexes WHERE indexname = 'integrations_undo_sweeper_idx'
		`
		expect(def.indexdef).toMatch(/\(status, undo_expires_at\)/)
		expect(def.indexdef).toMatch(/WHERE \(?\(?status = 'pending_undo'/)
	})

	it('a row inserted the pre-Keychain way gets the defaults', async () => {
		const { row } = await newIntegration()
		const [out] = await sql<Record<string, unknown>[]>`
			INSERT INTO integrations ${sql(row)} RETURNING *
		`
		expect(out.provider_mode).toBe('registered')
		expect(out.source).toBe('admin_ui')
		expect(out.dek_ciphertext).toBeNull()
		expect(out.scope_grants).toEqual([])
		expect(out.origin_session_id).toBeNull()
		expect(out.undo_expires_at).toBeNull()
		expect(out.display_name).toBeNull()
	})

	it('CHECK: a BYO row needs a display name, a registered row does not', async () => {
		const { row } = await newIntegration()
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, provider_mode: 'byo_apikey' })}`,
		).rejects.toThrow(/integrations_byo_needs_display_name/)
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, provider_mode: 'byo_apikey', display_name: 'Notion, team' })}`,
		).resolves.toBeDefined()
	})

	it('CHECK: scope_grants must be an array', async () => {
		const { row } = await newIntegration()
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, scope_grants: sql.json({ kind: 'workspace' }) })}`,
		).rejects.toThrow(/integrations_scope_grants_is_array/)
	})

	it('CHECK: source must be one of the four values', async () => {
		const { row } = await newIntegration()
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, source: 'carrier_pigeon' })}`,
		).rejects.toThrow(/integrations_source_enum/)
	})

	it('CHECK: a chat_capture row needs an origin session', async () => {
		const { row } = await newIntegration()
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, source: 'chat_capture' })}`,
		).rejects.toThrow(/integrations_chat_capture_has_session/)
	})
})

describe('workspace_kms_aliases (0087)', () => {
	it('has the specified shape and a workspace FK', async () => {
		const cols = await columns('workspace_kms_aliases')
		expect([...cols.keys()].sort()).toEqual(['created_at', 'kek_alias', 'provider', 'workspace_id'])
		expect(cols.get('provider')?.column_default).toContain('aws-kms')

		const { ws } = await newIntegration()
		await sql`INSERT INTO workspace_kms_aliases (workspace_id, kek_alias) VALUES (${ws.id}, 'alias/x')`
		await expect(
			sql`INSERT INTO workspace_kms_aliases (workspace_id, kek_alias) VALUES (${ws.id}, 'alias/y')`,
		).rejects.toThrow(/duplicate key/)
		await expect(
			sql`INSERT INTO workspace_kms_aliases (workspace_id, kek_alias) VALUES (gen_random_uuid(), 'alias/z')`,
		).rejects.toThrow(/foreign key/)
	})
})

describe('credential_access_log (0087)', () => {
	it('has the specified columns, defaults and indexes', async () => {
		const cols = await columns('credential_access_log')
		for (const name of [
			'id',
			'workspace_id',
			'integration_id',
			'actor_id',
			'session_id',
			'loop_id',
			'detail',
			'outbound_target',
			'action',
			'source',
			'request_id',
			'read_at',
			'prev_row_hash',
			'row_hash',
		]) {
			expect(cols.has(name), name).toBe(true)
		}
		expect(cols.get('action')?.column_default).toContain('read')
		expect(cols.get('source')?.column_default).toContain('unknown')
		const names = await indexNames('credential_access_log')
		for (const idx of [
			'cal_ws_read_at_idx',
			'cal_integration_read_at_idx',
			'cal_actor_read_at_idx',
			'cal_action_idx',
		]) {
			expect(names).toContain(idx)
		}
	})

	async function seedLog() {
		const { ws, row } = await newIntegration()
		const [integration] = await sql<
			{ id: string }[]
		>`INSERT INTO integrations ${sql(row)} RETURNING id`
		return { ws, integrationId: integration.id, actorId: getTestActorId() }
	}

	// read_at goes in as text cast to timestamptz on purpose: postgres.js turns a
	// timestamptz parameter into a JavaScript Date, which truncates to milliseconds.
	const insertRow = (
		s: { ws: { id: string }; integrationId: string; actorId: string },
		extra: {
			requestId?: string
			readAt?: string
			sessionId?: string | null
			loopId?: string | null
			detail?: string | null
			prevRowHash?: string
			rowHash?: string
		} = {},
	) => sql<{ id: string; prev_row_hash: string; row_hash: string }[]>`
		INSERT INTO credential_access_log
			(workspace_id, integration_id, actor_id, request_id, session_id, loop_id, detail, read_at, prev_row_hash, row_hash)
		VALUES (${s.ws.id}, ${s.integrationId}, ${s.actorId}, ${extra.requestId ?? 'req-1'},
			${extra.sessionId ?? null}, ${extra.loopId ?? null}, ${extra.detail ?? null},
			coalesce(${extra.readAt ?? null}::text::timestamptz, now()),
			${extra.prevRowHash ?? ''}, ${extra.rowHash ?? ''})
		RETURNING id::text, prev_row_hash, row_hash
	`

	it('chains from the genesis constant, and callers cannot choose the hashes', async () => {
		const s = await seedLog()
		const [a] = await insertRow(s, { prevRowHash: 'forged', rowHash: 'forged-too' })
		const [b] = await insertRow(s)
		expect(a.prev_row_hash).toBe(CREDENTIAL_LOG_GENESIS_HASH)
		expect(a.row_hash).not.toBe('forged-too')
		expect(b.prev_row_hash).toBe(a.row_hash)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 2 })
	})

	it('keeps one chain per workspace', async () => {
		const one = await seedLog()
		const two = await seedLog()
		await insertRow(one)
		const [first] = await insertRow(two)
		expect(first.prev_row_hash).toBe(CREDENTIAL_LOG_GENESIS_HASH)
	})

	it('a row with a microsecond read_at passes the verifier', async () => {
		const s = await seedLog()
		await insertRow(s, { readAt: '2026-10-03 12:00:00.123456+00', sessionId: null })
		await insertRow(s, { readAt: '2026-10-03 12:00:00.123457+00' })
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 2 })
	})

	it('a hash built from a JavaScript Date does NOT match: the canonical form is microsecond text', async () => {
		const s = await seedLog()
		const [row] = await insertRow(s, { readAt: '2026-10-03 12:00:00.123456+00' })
		const [text] = await sql<{ t: string }[]>`
			SELECT credential_access_log_ts_text(read_at) AS t FROM credential_access_log WHERE id = ${row.id}
		`
		expect(text.t).toBe('2026-10-03T12:00:00.123456Z')

		const fields = {
			prevRowHash: CREDENTIAL_LOG_GENESIS_HASH,
			workspaceId: s.ws.id,
			integrationId: s.integrationId,
			actorId: s.actorId,
			sessionId: null,
			loopId: null,
			outboundTarget: null,
			action: 'read',
			source: 'unknown',
			requestId: 'req-1',
			detail: null,
		}
		// What Postgres stored: microsecond text.
		expect(computeRowHash({ ...fields, readAtText: text.t })).toBe(row.row_hash)
		// What a verifier would compute from a JS Date: milliseconds only. It must not match,
		// which is why verifyCredentialAccessChain reads read_at as text.
		const fromDate = new Date('2026-10-03T12:00:00.123456Z').toISOString()
		expect(fromDate).toBe('2026-10-03T12:00:00.123Z')
		expect(computeRowHash({ ...fields, readAtText: fromDate })).not.toBe(row.row_hash)
	})

	it('the verifier reports a broken link', async () => {
		const s = await seedLog()
		await insertRow(s)
		const [b] = await insertRow(s)
		// Tamper as the table owner (the app role could not).
		await sql`UPDATE credential_access_log SET actor_id = ${(await insertActor(db)).id} WHERE id = ${b.id}`
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({
			ok: false,
			brokenAtId: b.id,
			reason: 'row_hash does not match contents',
		})
	})

	it('TS computeRowHash equals the trigger hash, with loop_id set and with loop_id NULL', async () => {
		const s = await seedLog()
		const loopId = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
		let prev = CREDENTIAL_LOG_GENESIS_HASH
		for (const withLoop of [loopId, null]) {
			const [row] = await insertRow(s, {
				loopId: withLoop,
				readAt: '2026-10-03 12:00:00.123456+00',
			})
			const [text] = await sql<{ t: string }[]>`
				SELECT credential_access_log_ts_text(read_at) AS t FROM credential_access_log WHERE id = ${row.id}
			`
			expect(row.prev_row_hash).toBe(prev)
			expect(
				computeRowHash({
					prevRowHash: prev,
					workspaceId: s.ws.id,
					integrationId: s.integrationId,
					actorId: s.actorId,
					sessionId: null,
					loopId: withLoop,
					outboundTarget: null,
					action: 'read',
					source: 'unknown',
					requestId: 'req-1',
					readAtText: text.t,
					detail: null,
				}),
			).toBe(row.row_hash)
			prev = row.row_hash
		}
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 2 })
	})

	it('changing loop_id on a row breaks the chain at that row', async () => {
		const s = await seedLog()
		const loopA = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
		const loopB = '1c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e'
		await insertRow(s, { loopId: loopA })
		const [b] = await insertRow(s, { loopId: loopA })
		await insertRow(s)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 3 })
		// Tamper as the table owner (the app role could not).
		await sql`UPDATE credential_access_log SET loop_id = ${loopB} WHERE id = ${b.id}`
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({
			ok: false,
			rows: 1,
			brokenAtId: b.id,
			reason: 'row_hash does not match contents',
		})
	})

	it('filling in a NULL loop_id on a row breaks the chain at that row', async () => {
		const s = await seedLog()
		await insertRow(s)
		const [b] = await insertRow(s)
		await insertRow(s)
		await sql`UPDATE credential_access_log SET loop_id = ${'0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'} WHERE id = ${b.id}`
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({
			ok: false,
			rows: 1,
			brokenAtId: b.id,
			reason: 'row_hash does not match contents',
		})
	})

	it('TS computeRowHash equals the trigger hash, with detail NULL, a canonical string, and non-ASCII text', async () => {
		const s = await seedLog()
		const details = [
			null,
			'approver=5f0c2d1e-1a2b-4c3d-8e4f-5a6b7c8d9e0f;grant=7a1b2c3d-4e5f-4a6b-9c8d-0e1f2a3b4c5d;tier=1;ext=',
			'approver=Søren Ærlig;note=日本語 ✓ café',
		]
		let prev = CREDENTIAL_LOG_GENESIS_HASH
		for (const detail of details) {
			const [row] = await insertRow(s, { detail, readAt: '2026-10-03 12:00:00.123456+00' })
			const [text] = await sql<{ t: string }[]>`
				SELECT credential_access_log_ts_text(read_at) AS t FROM credential_access_log WHERE id = ${row.id}
			`
			expect(row.prev_row_hash).toBe(prev)
			expect(
				computeRowHash({
					prevRowHash: prev,
					workspaceId: s.ws.id,
					integrationId: s.integrationId,
					actorId: s.actorId,
					sessionId: null,
					loopId: null,
					outboundTarget: null,
					action: 'read',
					source: 'unknown',
					requestId: 'req-1',
					readAtText: text.t,
					detail,
				}),
			).toBe(row.row_hash)
			prev = row.row_hash
		}
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 3 })
	})

	it('a row with detail NULL still verifies, and NULL and empty detail hash the same', async () => {
		const s = await seedLog()
		const [a] = await insertRow(s, { readAt: '2026-10-03 12:00:00.123456+00' })
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 1 })
		const [b] = await sql<{ row_hash: string }[]>`
			INSERT INTO credential_access_log
				(workspace_id, integration_id, actor_id, request_id, detail, read_at)
			VALUES (${s.ws.id}, ${s.integrationId}, ${s.actorId}, 'req-1', '', '2026-10-03 12:00:00.123456+00')
			RETURNING row_hash
		`
		// b has detail '' and chains after a. Recomputing it with detail NULL gives the same hash.
		expect(
			computeRowHash({
				prevRowHash: a.row_hash,
				workspaceId: s.ws.id,
				integrationId: s.integrationId,
				actorId: s.actorId,
				sessionId: null,
				loopId: null,
				outboundTarget: null,
				action: 'read',
				source: 'unknown',
				requestId: 'req-1',
				readAtText: '2026-10-03T12:00:00.123456Z',
				detail: null,
			}),
		).toBe(b.row_hash)
	})

	it('setting detail on a row that had none breaks the chain at that row', async () => {
		const s = await seedLog()
		await insertRow(s)
		const [b] = await insertRow(s)
		await insertRow(s)
		await sql`UPDATE credential_access_log SET detail = 'approver=x' WHERE id = ${b.id}`
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({
			ok: false,
			rows: 1,
			brokenAtId: b.id,
			reason: 'row_hash does not match contents',
		})
	})

	it('changing detail on a row breaks the chain at that row', async () => {
		const s = await seedLog()
		await insertRow(s, { detail: 'approver=a;tier=1' })
		const [b] = await insertRow(s, { detail: 'approver=a;tier=1' })
		await insertRow(s)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 3 })
		await sql`UPDATE credential_access_log SET detail = 'approver=a;tier=2' WHERE id = ${b.id}`
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({
			ok: false,
			rows: 1,
			brokenAtId: b.id,
			reason: 'row_hash does not match contents',
		})
	})

	it('setting detail back to NULL on a row that had a value breaks the chain at that row', async () => {
		const s = await seedLog()
		await insertRow(s)
		const [b] = await insertRow(s, { detail: 'approver=a;tier=1' })
		await insertRow(s)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 3 })
		await sql`UPDATE credential_access_log SET detail = NULL WHERE id = ${b.id}`
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({
			ok: false,
			rows: 1,
			brokenAtId: b.id,
			reason: 'row_hash does not match contents',
		})
	})

	it('CHECK: detail may not contain the hash separator or exceed 512 characters', async () => {
		const s = await seedLog()
		await expect(insertRow(s, { detail: `a${String.fromCharCode(31)}b` })).rejects.toThrow(
			/credential_access_log_detail_check/,
		)
		await expect(insertRow(s, { detail: 'x'.repeat(513) })).rejects.toThrow(
			/credential_access_log_detail_check/,
		)
		await insertRow(s, { detail: 'x'.repeat(512) })
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('serialises concurrent inserts into one consistent chain', async () => {
		const s = await seedLog()
		await Promise.all(Array.from({ length: 20 }, (_, i) => insertRow(s, { requestId: `req-${i}` })))
		const rows = await sql<
			{ id: string }[]
		>`SELECT id::text FROM credential_access_log WHERE workspace_id = ${s.ws.id} ORDER BY id`
		expect(new Set(rows.map((r) => r.id)).size).toBe(20)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 20 })
	})

	it('the app role can INSERT and SELECT but not UPDATE, DELETE or TRUNCATE', async () => {
		const s = await seedLog()
		await sql.begin(async (tx) => {
			await tx.unsafe(`SET LOCAL ROLE ${CREDENTIAL_LOG_ROLE}`)
			await tx`INSERT INTO credential_access_log ${tx({
				workspace_id: s.ws.id,
				integration_id: s.integrationId,
				actor_id: s.actorId,
				request_id: 'as-app-role',
				detail: 'approver=as-app-role;tier=1',
			})}`
			const seen = await tx`SELECT count(*)::int AS n FROM credential_access_log`
			expect(seen[0].n).toBe(1)
		})
		for (const statement of [
			`UPDATE credential_access_log SET request_id = 'x'`,
			'DELETE FROM credential_access_log',
			'TRUNCATE credential_access_log',
		]) {
			await expect(
				sql.begin(async (tx) => {
					await tx.unsafe(`SET LOCAL ROLE ${CREDENTIAL_LOG_ROLE}`)
					await tx.unsafe(statement)
				}),
			).rejects.toThrow(/permission denied/)
		}
	})
})

describe('0087 up and down', () => {
	it('reverses cleanly and re-applies, keeping pre-existing rows on their defaults', async () => {
		await runSqlFile(DOWN_0089)
		await runSqlFile(DOWN)
		expect(await columns('credential_access_log')).toHaveProperty('size', 0)
		expect(await columns('workspace_kms_aliases')).toHaveProperty('size', 0)
		expect((await columns('integrations')).has('dek_ciphertext')).toBe(false)
		expect(await indexNames('integrations')).not.toContain('integrations_undo_sweeper_idx')
		const roles = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${CREDENTIAL_LOG_ROLE}`
		expect(roles).toHaveLength(0)

		// A row that exists before the migration is applied.
		const { row } = await newIntegration()
		await sql`INSERT INTO integrations ${sql(row)}`

		await runSqlFile(UP)
		await runSqlFile(UP_0089)
		const [out] = await sql<Record<string, unknown>[]>`
			SELECT provider_mode, source, dek_ciphertext, scope_grants, origin_session_id, undo_expires_at
			FROM integrations WHERE provider = 'fake-provider'
		`
		expect(out).toEqual({
			provider_mode: 'registered',
			source: 'admin_ui',
			dek_ciphertext: null,
			scope_grants: [],
			origin_session_id: null,
			undo_expires_at: null,
		})
	})

	it('is idempotent under repeated up/down', async () => {
		await runSqlFile(UP)
		await runSqlFile(DOWN_0089)
		await runSqlFile(DOWN)
		await runSqlFile(DOWN)
		await runSqlFile(UP)
		await runSqlFile(UP)
		await runSqlFile(UP_0089)
		expect((await columns('integrations')).has('dek_ciphertext')).toBe(true)
		expect(await indexNames('credential_access_log')).toContain('cal_action_idx')
	})
})

const UP_0088 = '0088_integrations_credentials_nullable.sql'
const DOWN_0088 = 'down/0088_integrations_credentials_nullable_down.sql'

describe('integrations.credentials nullable (0088)', () => {
	it('relaxes NOT NULL on credentials', async () => {
		expect((await columns('integrations')).get('credentials')?.is_nullable).toBe('YES')
	})

	it('CHECK: NULL credentials is legal only on an undone row', async () => {
		const { row } = await newIntegration()
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, credentials: null })}`,
		).rejects.toThrow(/integrations_credentials_null_only_when_undone/)
		await expect(
			sql`INSERT INTO integrations ${sql({ ...row, status: 'pending_undo', credentials: null })}`,
		).rejects.toThrow(/integrations_credentials_null_only_when_undone/)
		await sql`INSERT INTO integrations ${sql({ ...row, status: 'undone', credentials: null })}`
	})

	it('rejects zeroising credentials on a row that is not being undone', async () => {
		const { row } = await newIntegration()
		const [out] = await sql<{ id: string }[]>`INSERT INTO integrations ${sql(row)} RETURNING id`
		await expect(
			sql`UPDATE integrations SET credentials = NULL WHERE id = ${out?.id as string}`,
		).rejects.toThrow(/integrations_credentials_null_only_when_undone/)
		await sql`UPDATE integrations SET credentials = NULL, status = 'undone' WHERE id = ${out?.id as string}`
	})

	it('reverses cleanly (blanking undone rows) and re-applies', async () => {
		const { row } = await newIntegration()
		const [undone] = await sql<{ id: string }[]>`
			INSERT INTO integrations ${sql({ ...row, status: 'undone', credentials: null })} RETURNING id
		`
		await runSqlFile(DOWN_0088)
		expect((await columns('integrations')).get('credentials')?.is_nullable).toBe('NO')
		const [blanked] = await sql<{ credentials: string }[]>`
			SELECT credentials FROM integrations WHERE id = ${undone?.id as string}
		`
		expect(blanked?.credentials).toBe('')

		await runSqlFile(UP_0088)
		expect((await columns('integrations')).get('credentials')?.is_nullable).toBe('YES')
		// And again: down on an already-reverted schema must not fail.
		await runSqlFile(DOWN_0088)
		await runSqlFile(DOWN_0088)
		await runSqlFile(UP_0088)
	})
})

const UNIQ = 'integrations_ws_actor_provider_null_external_uniq'

const byo = (row: Record<string, unknown>, name: string, extra: Record<string, unknown> = {}) => ({
	...row,
	provider_mode: 'byo_apikey',
	display_name: name,
	source: 'admin_ui',
	...extra,
})

describe('one connection per provider, not one key (0089)', () => {
	it('lets a workspace hold several byo_apikey keys for one provider, undone ones included', async () => {
		const { row } = await newIntegration({ provider: 'cloudflare' })
		await sql`INSERT INTO integrations ${sql(byo(row, 'First'))}`
		await sql`INSERT INTO integrations ${sql(byo(row, 'Second'))}`
		await sql`INSERT INTO integrations ${sql(byo(row, 'Undone', { status: 'undone', credentials: null }))}`
		const [count] = await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM integrations WHERE workspace_id = ${row.workspace_id as string}
		`
		expect(count?.n).toBe(3)
	})

	it('still allows one registered connection per provider', async () => {
		const { row } = await newIntegration({ provider: 'slack' })
		await sql`INSERT INTO integrations ${sql(row)}`
		await expect(sql`INSERT INTO integrations ${sql(row)}`).rejects.toThrow(new RegExp(UNIQ))
	})

	it('still allows one OAuth connection per provider', async () => {
		const { row } = await newIntegration({ provider: 'linear' })
		const oauth = { ...row, provider_mode: 'byo_oauth', display_name: 'Linear' }
		await sql`INSERT INTO integrations ${sql(oauth)}`
		await expect(sql`INSERT INTO integrations ${sql(oauth)}`).rejects.toThrow(new RegExp(UNIQ))
	})

	it('keeps the index and narrows its predicate', async () => {
		const [idx] = await sql<{ indexdef: string }[]>`
			SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${UNIQ}
		`
		expect(idx?.indexdef).toContain('NULLS NOT DISTINCT')
		expect(idx?.indexdef).toMatch(/byo_apikey/)
	})

	it('reverses only once duplicate keys are gone, and re-applies', async () => {
		const { row } = await newIntegration({ provider: 'cloudflare' })
		await sql`INSERT INTO integrations ${sql(byo(row, 'First'))}`
		const [second] = await sql<{ id: string }[]>`
			INSERT INTO integrations ${sql(byo(row, 'Second'))} RETURNING id
		`
		// The documented precondition: down refuses while two keys share a provider.
		await expect(runSqlFile(DOWN_0089)).rejects.toThrow()
		// The failed down ran in one transaction, so the new index is still in place.
		expect((await indexNames('integrations')).filter((n) => n === UNIQ)).toHaveLength(1)

		await sql`DELETE FROM integrations WHERE id = ${second?.id as string}`
		await runSqlFile(DOWN_0089)
		await expect(sql`INSERT INTO integrations ${sql(byo(row, 'Again'))}`).rejects.toThrow(
			new RegExp(UNIQ),
		)

		await runSqlFile(UP_0089)
		await sql`INSERT INTO integrations ${sql(byo(row, 'Again'))}`
		// Up on an already-applied schema must not fail either.
		await runSqlFile(UP_0089)
	})
})
