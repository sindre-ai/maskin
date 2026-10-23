import type { Database } from '@maskin/db'
import { triggers, workspaceMembers } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lets one test make the real backfill fail after it has written, to prove the rollback.
const backfillControl = vi.hoisted(() => ({ failAfterRun: false }))
vi.mock('../../services/default-heartbeat', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../services/default-heartbeat')>()
	return {
		...original,
		backfillDefaultHeartbeats: async (
			...args: Parameters<typeof original.backfillDefaultHeartbeats>
		) => {
			const result = await original.backfillDefaultHeartbeats(...args)
			if (backfillControl.failAfterRun) throw new Error('backfill blew up')
			return result
		},
	}
})

import {
	HEARTBEAT_BACKFILL_ENV,
	HEARTBEAT_BACKFILL_MARKER,
	runDefaultHeartbeatBackfillOnBoot,
} from '../../lib/default-heartbeat-boot'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const ON = { [HEARTBEAT_BACKFILL_ENV]: '1' } as NodeJS.ProcessEnv

async function markerRows() {
	return db.execute(sql`SELECT 1 FROM "_migrations" WHERE "name" = ${HEARTBEAT_BACKFILL_MARKER}`)
}

async function newAgentWithoutHeartbeat() {
	const ws = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, { type: 'agent', name: 'Boot backfill agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	return agent
}

async function heartbeatsFor(actorId: string) {
	return db.select().from(triggers).where(eq(triggers.targetActorId, actorId))
}

describe('Default Heartbeat boot backfill', () => {
	beforeEach(async () => {
		backfillControl.failAfterRun = false
		await db.execute(sql`DELETE FROM "_migrations" WHERE "name" = ${HEARTBEAT_BACKFILL_MARKER}`)
	})

	it('does nothing when the flag is off', async () => {
		const agent = await newAgentWithoutHeartbeat()

		const offValues = [{}, { [HEARTBEAT_BACKFILL_ENV]: '0' }, { [HEARTBEAT_BACKFILL_ENV]: 'true' }]
		for (const env of offValues) {
			const outcome = await runDefaultHeartbeatBackfillOnBoot(db, env as NodeJS.ProcessEnv)
			expect(outcome).toEqual({ status: 'disabled' })
		}

		expect(await heartbeatsFor(agent.id)).toHaveLength(0)
		expect(await markerRows()).toHaveLength(0)
	})

	it('runs once with the flag on, reports the counts and writes the marker', async () => {
		const agent = await newAgentWithoutHeartbeat()

		const outcome = await runDefaultHeartbeatBackfillOnBoot(db, ON)

		expect(outcome.status).toBe('done')
		if (outcome.status !== 'done') throw new Error('unreachable')
		expect(outcome.result.eligible).toBeGreaterThanOrEqual(1)
		expect(outcome.result.created).toBeGreaterThanOrEqual(1)
		expect(outcome.result.reworded).toBe(0)
		expect(await heartbeatsFor(agent.id)).toHaveLength(1)
		expect(await markerRows()).toHaveLength(1)
	})

	it('skips a second boot with the flag still set, so a deleted Heartbeat stays deleted', async () => {
		const agent = await newAgentWithoutHeartbeat()
		await runDefaultHeartbeatBackfillOnBoot(db, ON)
		await db.delete(triggers).where(eq(triggers.targetActorId, agent.id))

		const outcome = await runDefaultHeartbeatBackfillOnBoot(db, ON)

		expect(outcome).toEqual({ status: 'already_done' })
		expect(await heartbeatsFor(agent.id)).toHaveLength(0)
		expect(await markerRows()).toHaveLength(1)
	})

	it('runs only once when several replicas boot at the same time', async () => {
		const agent = await newAgentWithoutHeartbeat()

		const outcomes = await Promise.all([
			runDefaultHeartbeatBackfillOnBoot(db, ON),
			runDefaultHeartbeatBackfillOnBoot(db, ON),
			runDefaultHeartbeatBackfillOnBoot(db, ON),
		])

		expect(outcomes.filter((o) => o.status === 'done')).toHaveLength(1)
		expect(outcomes.filter((o) => o.status === 'already_done')).toHaveLength(2)
		expect(await heartbeatsFor(agent.id)).toHaveLength(1)
		expect(await markerRows()).toHaveLength(1)
	})

	it('does not throw when the backfill fails, and leaves no marker or half-written Heartbeats', async () => {
		const agent = await newAgentWithoutHeartbeat()
		backfillControl.failAfterRun = true

		const outcome = await runDefaultHeartbeatBackfillOnBoot(db, ON)

		expect(outcome).toEqual({ status: 'failed' })
		expect(await heartbeatsFor(agent.id)).toHaveLength(0)
		expect(await markerRows()).toHaveLength(0)

		// The next boot with the flag still set gets another go.
		backfillControl.failAfterRun = false
		const retry = await runDefaultHeartbeatBackfillOnBoot(db, ON)
		expect(retry.status).toBe('done')
		expect(await heartbeatsFor(agent.id)).toHaveLength(1)
	})

	it('does not throw when the database itself is unreachable', async () => {
		const brokenDb = {
			transaction: async () => {
				throw new Error('connection refused')
			},
		} as unknown as Database

		await expect(runDefaultHeartbeatBackfillOnBoot(brokenDb, ON)).resolves.toEqual({
			status: 'failed',
		})
	})
})
