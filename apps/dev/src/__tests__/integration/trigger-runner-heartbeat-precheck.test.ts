// The heartbeat pre-check on the cron path (bet "Agents take the lead", sweep task, item 4).
// It is record-only: behind the next-step-sweep flag, a daily heartbeat writes what it found and
// the run starts either way, even when the check itself fails.

import { events } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { readPrecheckFacts } from '../../lib/heartbeat-precheck'
import { HEARTBEAT_METADATA_KEY } from '../../services/default-heartbeat'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { newQueueRunner } from './queue-helpers'

const { startSessionMock, captureMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(
		async (_input: { config?: Record<string, unknown> }) =>
			({ sessionId: '', state: 'queued', createdAt: new Date() }) as const,
	),
	captureMock: vi.fn(async (_event: string, _id: string, _props: Record<string, unknown>) => {}),
}))

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: startSessionMock,
}))

vi.mock('../../lib/heartbeat-precheck', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../lib/heartbeat-precheck')>()
	return { ...original, readPrecheckFacts: vi.fn(original.readPrecheckFacts) }
})

describe('cron heartbeat pre-check (integration)', () => {
	let workspaceId: string
	let agentId: string
	let previousFeatures: string | undefined

	type FireCron = (trigger: unknown, tick: Date) => Promise<void>
	const fire = (trigger: unknown) => {
		const { runner } = newQueueRunner()
		return (runner as unknown as { fireCronTrigger: FireCron }).fireCronTrigger(trigger, new Date())
	}

	const heartbeat = (metadata?: Record<string, unknown>) =>
		insertTrigger(db, workspaceId, getTestActorId(), agentId, {
			type: 'cron',
			config: { expression: '0 2 * * *' },
			metadata: metadata ?? { [HEARTBEAT_METADATA_KEY]: { prompt_sha: 'test' } },
		})

	// The heartbeat last ran a day ago, so the 3-day floor is not reached and nothing is due.
	async function ranYesterday(triggerId: string) {
		await db.insert(events).values({
			workspaceId,
			actorId: agentId,
			action: 'trigger_fired',
			entityType: 'trigger',
			entityId: triggerId,
			data: {},
			createdAt: new Date(Date.now() - 24 * 3_600_000),
		})
	}

	const prechecks = (triggerId: string) =>
		db
			.select()
			.from(events)
			.where(and(eq(events.entityId, triggerId), eq(events.action, 'heartbeat_precheck')))

	const woken = () => captureMock.mock.calls.filter((c) => c[0] === 'driver_woken').map((c) => c[2])

	beforeEach(async () => {
		captureMock.mockClear()
		startSessionMock.mockClear()
		vi.mocked(readPrecheckFacts).mockClear()
		previousFeatures = process.env.FF_WORKSPACE_FEATURES
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Owner' })).id
	})

	afterEach(() => {
		if (previousFeatures === undefined) Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		else process.env.FF_WORKSPACE_FEATURES = previousFeatures
		_resetFeatureFlagConfig()
	})

	function flagOn() {
		process.env.FF_WORKSPACE_FEATURES = `${workspaceId}:next-step-sweep`
		_resetFeatureFlagConfig()
	}

	it('with the flag off it writes nothing and the run starts as before', async () => {
		const trigger = await heartbeat()
		await ranYesterday(trigger.id)

		await fire(trigger)

		expect(readPrecheckFacts).not.toHaveBeenCalled()
		expect(await prechecks(trigger.id)).toHaveLength(0)
		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0]?.[0].config).toBeUndefined()
		expect(woken()).toHaveLength(0)
	})

	it('with the flag on it writes the event and the run still starts', async () => {
		flagOn()
		const trigger = await heartbeat()
		await ranYesterday(trigger.id)

		await fire(trigger)

		const [row] = await prechecks(trigger.id)
		expect(row?.data).toMatchObject({ would_skip: true, reasons: ['nothing_due'] })
		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0]?.[0].config).toMatchObject({
			driver_wake: { source: 'heartbeat', reasons: ['nothing_due'] },
		})
		expect(woken()).toEqual([
			expect.objectContaining({ source: 'heartbeat', outcome: 'skipped_nothing_due' }),
		])
	})

	it('a trigger without the daily heartbeat marker is not pre-checked', async () => {
		flagOn()
		const trigger = await heartbeat({})
		await ranYesterday(trigger.id)

		await fire(trigger)

		expect(await prechecks(trigger.id)).toHaveLength(0)
		expect(startSessionMock).toHaveBeenCalledTimes(1)
	})

	it('when the check fails the run still starts and nothing is written', async () => {
		flagOn()
		const trigger = await heartbeat()
		await ranYesterday(trigger.id)
		vi.mocked(readPrecheckFacts).mockRejectedValueOnce(new Error('boom'))

		await fire(trigger)

		expect(await prechecks(trigger.id)).toHaveLength(0)
		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0]?.[0].config).toBeUndefined()
		expect(woken()).toHaveLength(0)
	})
})
