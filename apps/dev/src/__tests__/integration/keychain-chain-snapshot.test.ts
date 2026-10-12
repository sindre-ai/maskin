import { WormSnapshotStore, type WormSnapshotStoreConfig } from '@maskin/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import {
	ChainSnapshotJob,
	VERIFICATION_FAILED_EVENT,
	snapshotKey,
} from '../../jobs/keychain-chain-snapshot'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

class AwsError extends Error {
	constructor(name: string) {
		super(name)
		this.name = name
	}
}

/** An in-memory bucket behind the S3 client interface, with a log of what was sent. */
function fakeBucket(opts: { denyList?: boolean } = {}) {
	const objects = new Map<string, string>()
	const sent: string[] = []
	const client = {
		async send(command: { constructor: { name: string }; input: Record<string, string> }) {
			const name = command.constructor.name
			sent.push(name)
			switch (name) {
				case 'ListObjectsV2Command': {
					if (opts.denyList) throw new AwsError('AccessDenied')
					const prefix = command.input.Prefix ?? ''
					const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
					return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false }
				}
				case 'PutObjectCommand': {
					if (command.input.IfNoneMatch === '*' && objects.has(command.input.Key)) {
						throw new AwsError('PreconditionFailed')
					}
					objects.set(command.input.Key, command.input.Body)
					return {}
				}
				case 'GetObjectCommand': {
					const body = objects.get(command.input.Key)
					if (body === undefined) throw new AwsError('NoSuchKey')
					return { Body: { transformToString: async () => body } }
				}
				default:
					throw new Error(`unexpected S3 command ${name}`)
			}
		},
	}
	const store = new WormSnapshotStore({ bucket: 'worm', client: client as unknown as WormSnapshotStoreConfig['client'] })
	return { store, objects, sent, puts: () => sent.filter((n) => n === 'PutObjectCommand').length }
}

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

const jobAt = (store: WormSnapshotStore | null, iso: string) =>
	new ChainSnapshotJob(db, store, () => new Date(iso))

beforeEach(() => captureMock.mockClear())

describe('ChainSnapshotJob', () => {
	it('writes one object per workspace holding the chain head, and writes nothing on a second run the same day', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		const job = jobAt(bucket.store, '2026-10-12T02:31:00Z')

		expect(await job.snapshotWorkspace(bucket.store, s.ws.id)).toBe('written')

		const key = snapshotKey(s.ws.id, '2026-10-12')
		const h = await head(s.ws.id)
		expect(key).toBe(`snapshots/${s.ws.id}/2026-10-12.json`)
		expect(JSON.parse(bucket.objects.get(key) as string)).toEqual({
			max_id: h.id,
			row_hash: h.hash,
			date: '2026-10-12',
		})

		const putsAfterFirst = bucket.puts()
		expect(await job.snapshotWorkspace(bucket.store, s.ws.id)).toBe('unchanged')
		expect(bucket.puts()).toBe(putsAfterFirst)
		expect(bucket.objects.size).toBe(1)
	})

	it('writes a new object only when the chain has grown since the latest snapshot', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(bucket.store, s.ws.id)

		// Next day, nothing new: nothing written.
		const nextDay = jobAt(bucket.store, '2026-10-13T02:31:00Z')
		expect(await nextDay.snapshotWorkspace(bucket.store, s.ws.id)).toBe('unchanged')
		expect(bucket.objects.size).toBe(1)

		// Next day, new rows: a second object with the new head.
		await addRow(s)
		expect(await nextDay.snapshotWorkspace(bucket.store, s.ws.id)).toBe('written')
		const h = await head(s.ws.id)
		expect(JSON.parse(bucket.objects.get(snapshotKey(s.ws.id, '2026-10-13')) as string)).toEqual({
			max_id: h.id,
			row_hash: h.hash,
			date: '2026-10-13',
		})
		expect(bucket.objects.size).toBe(2)
	})

	it('listing returns no exact match: writes', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		expect(await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(bucket.store, s.ws.id)).toBe(
			'written',
		)
		expect(bucket.puts()).toBe(1)
	})

	it('exact match for today: skips without a PUT', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		// Today's object exists but the chain has since grown, so only the exact-key check can stop a write.
		const first = await chainHeadSnapshot(s, bucket, '2026-10-12')
		await addRow(s)
		const puts = bucket.puts()

		const outcome = await jobAt(bucket.store, '2026-10-12T20:00:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('already_written')
		expect(bucket.puts()).toBe(puts)
		expect(bucket.objects.get(snapshotKey(s.ws.id, '2026-10-12'))).toBe(first)
	})

	it('a longer key that only shares the prefix does not count as a match: writes', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		bucket.objects.set(`${snapshotKey(s.ws.id, '2026-10-12')}.bak`, '{"not":"a snapshot"}')
		// The longer key is under the workspace prefix but is not a .json snapshot name.

		const outcome = await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('written')
		expect(bucket.objects.has(snapshotKey(s.ws.id, '2026-10-12'))).toBe(true)
	})

	it('a 403 on the lookup is a failure: nothing is written and nothing is retried', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket({ denyList: true })

		const outcome = await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('failed')
		expect(bucket.puts()).toBe(0)
		expect(bucket.sent.filter((n) => n === 'ListObjectsV2Command')).toHaveLength(1)
	})

	it('a broken chain fires the failure event and writes nothing', async () => {
		const s = await chainWorkspace(3)
		const second = (await sql<{ id: string }[]>`
			SELECT id::text FROM credential_access_log WHERE workspace_id = ${s.ws.id} ORDER BY id OFFSET 1 LIMIT 1
		`)[0] as { id: string }
		// Tamper as the table owner (the app role could not).
		await sql`UPDATE credential_access_log SET request_id = 'edited' WHERE id = ${second.id}::bigint`
		const bucket = fakeBucket()

		const outcome = await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('chain_broken')
		expect(bucket.puts()).toBe(0)
		expect(captureMock).toHaveBeenCalledWith(
			VERIFICATION_FAILED_EVENT,
			expect.any(String),
			expect.objectContaining({ workspace_id: s.ws.id, kind: 'chain_broken', at_id: second.id }),
		)
	})

	it('a whole-chain rewrite is caught by the snapshot: same row id, different hash', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		const h = await head(s.ws.id)
		// A snapshot written earlier, whose hash no longer matches what the database holds.
		bucket.objects.set(
			snapshotKey(s.ws.id, '2026-10-01'),
			JSON.stringify({ max_id: h.id, row_hash: 'f'.repeat(64), date: '2026-10-01' }),
		)

		const outcome = await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('snapshot_mismatch')
		expect(bucket.puts()).toBe(0)
		expect(captureMock).toHaveBeenCalledWith(
			VERIFICATION_FAILED_EVENT,
			expect.any(String),
			expect.objectContaining({ workspace_id: s.ws.id, kind: 'snapshot_mismatch' }),
		)
	})

	it('a snapshot row that is gone from the chain fires the failure event', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()
		const h = await head(s.ws.id)
		bucket.objects.set(
			snapshotKey(s.ws.id, '2026-10-01'),
			JSON.stringify({ max_id: String(BigInt(h.id) + 1000n), row_hash: h.hash, date: '2026-10-01' }),
		)

		const outcome = await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('snapshot_mismatch')
		expect(bucket.puts()).toBe(0)
	})

	it('verifies and snapshots a chain whose rows have non-zero microseconds', async () => {
		const s = await chainWorkspace(3)
		const [text] = await sql<{ t: string }[]>`
			SELECT credential_access_log_ts_text(read_at) AS t FROM credential_access_log
			WHERE workspace_id = ${s.ws.id} ORDER BY id LIMIT 1
		`
		expect((text as { t: string }).t).toMatch(/\.\d{6}Z$/)
		expect((text as { t: string }).t).not.toMatch(/\.000000Z$/)
		const bucket = fakeBucket()

		const outcome = await jobAt(bucket.store, '2026-10-12T02:31:00Z').snapshotWorkspace(
			bucket.store,
			s.ws.id,
		)

		expect(outcome).toBe('written')
	})

	it('run() snapshots every workspace with a chain, and is inert with no bucket', async () => {
		const s = await chainWorkspace()
		const bucket = fakeBucket()

		const result = await jobAt(bucket.store, '2026-10-12T02:31:00Z').run()

		expect(result.enabled).toBe(true)
		expect(result.written).toBeGreaterThanOrEqual(1)
		expect(bucket.objects.has(snapshotKey(s.ws.id, '2026-10-12'))).toBe(true)

		const inert = await jobAt(null, '2026-10-12T02:31:00Z').run()
		expect(inert).toMatchObject({ enabled: false, written: 0 })
	})
})

async function chainHeadSnapshot(s: Chain, bucket: ReturnType<typeof fakeBucket>, date: string) {
	const h = await head(s.ws.id)
	const body = JSON.stringify({ max_id: h.id, row_hash: h.hash, date })
	bucket.objects.set(snapshotKey(s.ws.id, date), body)
	return body
}
