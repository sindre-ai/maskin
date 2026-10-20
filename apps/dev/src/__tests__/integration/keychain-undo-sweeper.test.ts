import { events, integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

// The sweeper must never reach KMS. Any call through this module fails the test.
const kmsMock = vi.hoisted(() => ({
	getKmsProvider: vi.fn(() => {
		throw new Error('sweeper called KMS')
	}),
}))
vi.mock('../../lib/keychain-kms', () => kmsMock)

import {
	KeychainUndoSweeperJob,
	SWEEP_ACTION,
	SWEEP_POSTHOG_EVENT,
	sweepStatement,
} from '../../jobs/keychain-undo-sweeper'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

beforeEach(() => {
	captureMock.mockClear()
	kmsMock.getKmsProvider.mockClear()
})

async function insertRow(
	workspaceId: string,
	provider: string,
	status: 'pending_undo' | 'active',
	undoExpiresAtOffsetSql: string | null,
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status,
			credentials: 'ciphertext-stays-as-is',
			dekCiphertext: 'wrapped-dek-stays-as-is',
			createdBy: getTestActorId(),
			// Offset from the database clock, the clock the sweeper judges by.
			undoExpiresAt:
				undoExpiresAtOffsetSql === null
					? null
					: (sql`now() + ${undoExpiresAtOffsetSql}::interval` as unknown as Date),
		})
		.returning()
	if (!row) throw new Error('insert returned no row')
	return row
}

async function sweepEvents(workspaceId: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.action, SWEEP_ACTION)))
}

async function reload(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	if (!row) throw new Error('row vanished')
	return row
}

describe('KeychainUndoSweeperJob', () => {
	it('flips a pending_undo row past its window to active and clears undo_expires_at', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const expired = await insertRow(ws.id, 'sweep-a', 'pending_undo', '-1 second')

		const swept = await new KeychainUndoSweeperJob(db).tick()

		expect(swept).toBeGreaterThanOrEqual(1)
		const after = await reload(expired.id)
		expect(after.status).toBe('active')
		expect(after.undoExpiresAt).toBeNull()
		// The envelope is untouched: the sweeper changes the status and nothing else.
		expect(after.credentials).toBe('ciphertext-stays-as-is')
		expect(after.dekCiphertext).toBe('wrapped-dek-stays-as-is')
	})

	it('leaves rows still inside their window, and active rows, untouched', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const inWindow = await insertRow(ws.id, 'sweep-b', 'pending_undo', '2 minutes')
		const alreadyActive = await insertRow(ws.id, 'sweep-c', 'active', null)

		await new KeychainUndoSweeperJob(db).tick()

		const a = await reload(inWindow.id)
		expect(a.status).toBe('pending_undo')
		expect(a.undoExpiresAt?.getTime()).toBe(inWindow.undoExpiresAt?.getTime())
		const b = await reload(alreadyActive.id)
		expect(b.status).toBe('active')
		expect(b.updatedAt?.getTime()).toBe(alreadyActive.updatedAt?.getTime())
		expect(await sweepEvents(ws.id)).toHaveLength(0)
	})

	it('picks up a row once its window passes (the two-minute smoke case)', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertRow(ws.id, 'sweep-d', 'pending_undo', '2 minutes')
		const job = new KeychainUndoSweeperJob(db)

		await job.tick()
		expect((await reload(row.id)).status).toBe('pending_undo')

		// Move the row's window into the past rather than sleeping two minutes.
		await db
			.update(integrations)
			.set({ undoExpiresAt: sql`now() - interval '1 second'` as unknown as Date })
			.where(eq(integrations.id, row.id))
		await job.tick()
		expect((await reload(row.id)).status).toBe('active')
	})

	it('is idempotent: a second run changes nothing and writes no second event', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await insertRow(ws.id, 'sweep-e', 'pending_undo', '-1 second')
		const job = new KeychainUndoSweeperJob(db)

		await job.tick()
		captureMock.mockClear()
		const second = await job.tick()

		expect(second).toBe(0)
		expect(await sweepEvents(ws.id)).toHaveLength(1)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('writes one batched events row per workspace and one PostHog event per run', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const r1 = await insertRow(ws.id, 'sweep-f1', 'pending_undo', '-2 seconds')
		const r2 = await insertRow(ws.id, 'sweep-f2', 'pending_undo', '-1 second')

		const swept = await new KeychainUndoSweeperJob(db).tick()

		const rows = await sweepEvents(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.entityType).toBe('integration')
		expect(rows[0]?.actorId).toBe(getTestActorId())
		const data = rows[0]?.data as { rows_activated: number; integration_ids: string[] }
		expect(data.rows_activated).toBe(2)
		expect([...data.integration_ids].sort()).toEqual([r1.id, r2.id].sort())

		expect(captureMock).toHaveBeenCalledTimes(1)
		const call = captureMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
		expect(call[0]).toBe(SWEEP_POSTHOG_EVENT)
		expect(call[2].rows_activated).toBe(swept)
	})

	it('never calls KMS', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await insertRow(ws.id, 'sweep-g', 'pending_undo', '-1 second')

		await new KeychainUndoSweeperJob(db).tick()

		expect(kmsMock.getKmsProvider).not.toHaveBeenCalled()
	})

	it('uses the partial index integrations_undo_sweeper_idx', async () => {
		const plan = await db.transaction(async (tx) => {
			// A near-empty test table would otherwise plan a sequential scan.
			await tx.execute(sql`SET LOCAL enable_seqscan = off`)
			const rows = (await tx.execute(sql`EXPLAIN ${sweepStatement}`)) as unknown as Array<
				Record<string, string>
			>
			return rows.map((r) => r['QUERY PLAN']).join('\n')
		})
		expect(plan).toContain('integrations_undo_sweeper_idx')
	})

	it('a failing tick is swallowed and the next tick still runs', async () => {
		const broken = {
			transaction: () => Promise.reject(new Error('db down')),
		}
		const job = new KeychainUndoSweeperJob(broken as never)
		await expect(job.tick()).resolves.toBe(0)
		await expect(job.tick()).resolves.toBe(0)
	})
})
