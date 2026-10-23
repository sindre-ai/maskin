import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import { ChainSnapshotJob, VERIFICATION_FAILED_EVENT } from '../../jobs/keychain-chain-snapshot'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

async function chainWorkspace(rows = 2) {
	const ws = await insertWorkspace(db, getTestActorId())
	const actor = await insertActor(db)
	const [integration] = await sql<{ id: string }[]>`
		INSERT INTO integrations (workspace_id, provider, status, credentials, created_by)
		VALUES (${ws.id}, 'snap-test', 'active', 'x', ${actor.id}) RETURNING id::text
	`
	const s = { ws, actorId: actor.id, integrationId: (integration as { id: string }).id }
	for (let i = 0; i < rows; i++) await addRow(s)
	return s
}

type Chain = Awaited<ReturnType<typeof chainWorkspace>>

// As the table owner, with an explicit microsecond read_at so the hashed text form is exercised.
let tick = 0
async function addRow(s: Chain) {
	tick++
	const [row] = await sql<{ id: string; row_hash: string }[]>`
		INSERT INTO credential_access_log
			(workspace_id, integration_id, actor_id, request_id, read_at, prev_row_hash, row_hash)
		VALUES (${s.ws.id}, ${s.integrationId}, ${s.actorId}, ${`snap-${tick}`},
			('2026-10-03 12:00:00.' || lpad(${String(100000 + tick)}, 6, '0') || '+00')::timestamptz, '', '')
		RETURNING id::text, row_hash
	`
	return row as { id: string; row_hash: string }
}

const head = async (workspaceId: string) => {
	const chain = await verifyCredentialAccessChain(db, workspaceId)
	if (!chain.ok) throw new Error('chain not ok')
	return { id: chain.headId as string, hash: chain.headHash as string }
}

const snapshots = (workspaceId: string) =>
	sql<{ date: string; max_id: string; row_hash: string }[]>`
		SELECT snapshot_date::text AS date, max_id::text AS max_id, row_hash
		FROM credential_chain_snapshots WHERE workspace_id = ${workspaceId} ORDER BY snapshot_date
	`

/** A snapshot written earlier, as the table owner (the table is append-only, so only inserts). */
const seedSnapshot = (workspaceId: string, date: string, maxId: string, rowHash: string) =>
	sql`INSERT INTO credential_chain_snapshots (workspace_id, snapshot_date, max_id, row_hash)
		VALUES (${workspaceId}, ${date}::date, ${maxId}::bigint, ${rowHash})`

const jobAt = (iso: string) => new ChainSnapshotJob(db, () => new Date(iso))

beforeEach(() => captureMock.mockClear())

describe('ChainSnapshotJob', () => {
	it('writes one row per workspace holding the chain head, and writes nothing on a second run the same day', async () => {
		const s = await chainWorkspace()
		const job = jobAt('2026-10-12T02:31:00Z')

		expect(await job.snapshotWorkspace(s.ws.id)).toBe('written')

		const h = await head(s.ws.id)
		expect(await snapshots(s.ws.id)).toEqual([
			{ date: '2026-10-12', max_id: h.id, row_hash: h.hash },
		])

		expect(await job.snapshotWorkspace(s.ws.id)).toBe('unchanged')
		expect(await snapshots(s.ws.id)).toHaveLength(1)
	})

	it('writes a new row only when the chain has grown since the latest snapshot', async () => {
		const s = await chainWorkspace()
		await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)

		// Next day, nothing new: nothing written.
		const nextDay = jobAt('2026-10-13T02:31:00Z')
		expect(await nextDay.snapshotWorkspace(s.ws.id)).toBe('unchanged')
		expect(await snapshots(s.ws.id)).toHaveLength(1)

		// Next day, new rows: a second row with the new head.
		await addRow(s)
		expect(await nextDay.snapshotWorkspace(s.ws.id)).toBe('written')
		const h = await head(s.ws.id)
		expect(await snapshots(s.ws.id)).toEqual([
			expect.objectContaining({ date: '2026-10-12' }),
			{ date: '2026-10-13', max_id: h.id, row_hash: h.hash },
		])
	})

	it('a row for today that already exists is kept, not overwritten', async () => {
		const s = await chainWorkspace()
		await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)
		const [first] = await snapshots(s.ws.id)
		await addRow(s)

		const outcome = await jobAt('2026-10-12T20:00:00Z').snapshotWorkspace(s.ws.id)

		expect(outcome).toBe('already_written')
		expect(await snapshots(s.ws.id)).toEqual([first])
	})

	it('a broken chain fires the failure event and writes nothing', async () => {
		const s = await chainWorkspace(3)
		const second = (
			await sql<{ id: string }[]>`
			SELECT id::text FROM credential_access_log WHERE workspace_id = ${s.ws.id} ORDER BY id OFFSET 1 LIMIT 1
		`
		)[0] as { id: string }
		// Tamper as the table owner (the app role could not).
		await sql`UPDATE credential_access_log SET request_id = 'edited' WHERE id = ${second.id}::bigint`

		const outcome = await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)

		expect(outcome).toBe('chain_broken')
		expect(await snapshots(s.ws.id)).toEqual([])
		expect(captureMock).toHaveBeenCalledWith(
			VERIFICATION_FAILED_EVENT,
			expect.any(String),
			expect.objectContaining({ workspace_id: s.ws.id, kind: 'chain_broken', at_id: second.id }),
		)
	})

	it('a whole-chain rewrite is caught by the snapshot: same row id, different hash', async () => {
		const s = await chainWorkspace()
		const h = await head(s.ws.id)
		await seedSnapshot(s.ws.id, '2026-10-01', h.id, 'f'.repeat(64))

		const outcome = await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)

		expect(outcome).toBe('snapshot_mismatch')
		expect(await snapshots(s.ws.id)).toHaveLength(1)
		expect(captureMock).toHaveBeenCalledWith(
			VERIFICATION_FAILED_EVENT,
			expect.any(String),
			expect.objectContaining({ workspace_id: s.ws.id, kind: 'snapshot_mismatch' }),
		)
	})

	it('a snapshot row that is gone from the chain fires the failure event', async () => {
		const s = await chainWorkspace()
		const h = await head(s.ws.id)
		await seedSnapshot(s.ws.id, '2026-10-01', String(BigInt(h.id) + 1000n), h.hash)

		const outcome = await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)

		expect(outcome).toBe('snapshot_mismatch')
		expect(await snapshots(s.ws.id)).toHaveLength(1)
	})

	it('verifies and snapshots a chain whose rows have non-zero microseconds', async () => {
		const s = await chainWorkspace(3)
		const [text] = await sql<{ t: string }[]>`
			SELECT credential_access_log_ts_text(read_at) AS t FROM credential_access_log
			WHERE workspace_id = ${s.ws.id} ORDER BY id LIMIT 1
		`
		expect((text as { t: string }).t).toMatch(/\.\d{6}Z$/)
		expect((text as { t: string }).t).not.toMatch(/\.000000Z$/)

		expect(await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)).toBe('written')
	})

	it('run() snapshots every workspace with a chain', async () => {
		const s = await chainWorkspace()

		const result = await jobAt('2026-10-12T02:31:00Z').run()

		expect(result.written).toBeGreaterThanOrEqual(1)
		expect(await snapshots(s.ws.id)).toHaveLength(1)
	})
})

describe('credential_chain_snapshots', () => {
	it('rejects UPDATE and DELETE, even for the table owner', async () => {
		const s = await chainWorkspace()
		await jobAt('2026-10-12T02:31:00Z').snapshotWorkspace(s.ws.id)

		await expect(
			sql`UPDATE credential_chain_snapshots SET row_hash = 'x' WHERE workspace_id = ${s.ws.id}`,
		).rejects.toThrow(/append-only/)
		await expect(
			sql`DELETE FROM credential_chain_snapshots WHERE workspace_id = ${s.ws.id}`,
		).rejects.toThrow(/append-only/)
		expect(await snapshots(s.ws.id)).toHaveLength(1)
	})

	it('allows one row per workspace per day', async () => {
		const s = await chainWorkspace()
		const h = await head(s.ws.id)
		await seedSnapshot(s.ws.id, '2026-10-01', h.id, h.hash)

		await expect(seedSnapshot(s.ws.id, '2026-10-01', h.id, h.hash)).rejects.toThrow(/duplicate key/)
	})
})
