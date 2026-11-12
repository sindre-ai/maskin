import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, nextSteps, triggerDispatches, triggers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Proof against real Postgres that a reminder fires at most once, is not lost when its
// session fails to start, re-reads its row at fire time, and carries its object. The
// claim table and the disabled flag are what a mocked DB cannot check.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

type FireOutcome = 'fired' | 'skipped' | 'start_failed'
interface ReminderInternals {
	fireReminder(triggerId: string): Promise<FireOutcome>
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

function newRunner(createSession: ReturnType<typeof vi.fn>) {
	const sessionManager = { createSession } as unknown as SessionManager
	configureSessionLifecycle({ db, sessionManager })
	const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
	const runner = new TriggerRunner(db, bridge, sessionManager)
	return runner as unknown as ReminderInternals
}

async function seed(config: Record<string, unknown>, objectOverrides?: Record<string, unknown>) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const agent = await insertActor(db, { type: 'agent', name: 'Reminder target' })
	const object = await insertObject(db, ws.id, actorId, {
		title: 'Quarterly plan',
		...objectOverrides,
	})
	const trigger = await insertTrigger(db, ws.id, actorId, agent.id, {
		type: 'reminder',
		name: 'Wake-up',
		actionPrompt: 'Check the plan',
		config: { scheduled_at: minutesFromNow(-1), object_id: object.id, ...config },
	})
	return { ws, agent, object, trigger }
}

async function seedStep(
	s: { ws: { id: string }; object: { id: string }; agent: { id: string } },
	id: string,
	status: 'open' | 'done' | 'skipped' | 'blocked',
) {
	await db.insert(nextSteps).values({
		id,
		workspaceId: s.ws.id,
		objectId: s.object.id,
		action: 'Check the plan',
		ownerActorId: s.agent.id,
		dueAt: new Date(),
		status,
		// A blocked step has to name what it waits on; a closed one has to name nothing.
		...(status === 'blocked' ? { blockedOnActorId: s.agent.id, blockedReason: 'Waiting' } : {}),
		...(status === 'done' || status === 'skipped'
			? { evidence: 'Closed', closedAt: new Date() }
			: {}),
	})
}

const readTrigger = async (id: string) =>
	(await db.select().from(triggers).where(eq(triggers.id, id)))[0]

describe('reminder fire (integration)', () => {
	it('starts the session on the pinned object, names it in the prompt, then disables itself', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({})

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('fired')

		expect(createSession).toHaveBeenCalledOnce()
		const [, opts] = createSession.mock.calls[0]
		expect(opts.initiatedFromObjectId).toBe(s.object.id)
		expect(opts.actionPrompt).toContain('Check the plan')
		expect(opts.actionPrompt).toContain('Quarterly plan')
		expect(opts.actionPrompt).toContain(s.object.id)
		expect((await readTrigger(s.trigger.id)).enabled).toBe(false)
	})

	it('two instances firing the same reminder start one session', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({})

		const outcomes = await Promise.all([
			newRunner(createSession).fireReminder(s.trigger.id),
			newRunner(createSession).fireReminder(s.trigger.id),
		])

		expect(createSession).toHaveBeenCalledOnce()
		expect([...outcomes].sort()).toEqual(['fired', 'skipped'])
	})

	it('keeps the reminder when its session fails to start, and fires it on the next try', async () => {
		const createSession = vi
			.fn()
			.mockRejectedValueOnce(new Error('no agent server'))
			.mockResolvedValue({ id: randomUUID() })
		const runner = newRunner(createSession)
		const s = await seed({})

		expect(await runner.fireReminder(s.trigger.id)).toBe('start_failed')
		expect((await readTrigger(s.trigger.id)).enabled).toBe(true)
		const claims = await db
			.select()
			.from(triggerDispatches)
			.where(eq(triggerDispatches.triggerId, s.trigger.id))
		expect(claims).toHaveLength(0)

		expect(await runner.fireReminder(s.trigger.id)).toBe('fired')
		expect(createSession).toHaveBeenCalledTimes(2)
		expect((await readTrigger(s.trigger.id)).enabled).toBe(false)
	})

	it('does nothing when the reminder was disabled after its timer was armed', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({})
		await db.update(triggers).set({ enabled: false }).where(eq(triggers.id, s.trigger.id))

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')
		expect(createSession).not.toHaveBeenCalled()
	})

	it('does nothing when the reminder was deleted after its timer was armed', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({})
		await db.delete(triggers).where(eq(triggers.id, s.trigger.id))

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')
		expect(createSession).not.toHaveBeenCalled()
	})

	it('a step-pinned reminder more than an hour late starts nothing and says why', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({ scheduled_at: minutesFromNow(-61), step_id: randomUUID() })

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')

		expect(createSession).not.toHaveBeenCalled()
		expect((await readTrigger(s.trigger.id)).enabled).toBe(false)
		const skipped = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.trigger.id), eq(events.action, 'trigger_skipped')))
		expect(skipped).toHaveLength(1)
		expect(skipped[0].data).toMatchObject({ reason: 'late' })
	})

	it('a step-pinned reminder under an hour late still fires', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const stepId = randomUUID()
		const s = await seed({ scheduled_at: minutesFromNow(-59), step_id: stepId })
		await seedStep(s, stepId, 'open')

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('fired')
		expect(createSession).toHaveBeenCalledOnce()
	})

	it('counts the wake on the step it woke for', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const stepId = randomUUID()
		const s = await seed({ step_id: stepId })
		await seedStep(s, stepId, 'open')

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('fired')

		const [step] = await db.select().from(nextSteps).where(eq(nextSteps.id, stepId))
		expect(step.wakeCount).toBe(1)
		expect(step.lastWokenAt).not.toBeNull()
	})

	it.each(['done', 'skipped', 'blocked'] as const)(
		'a reminder whose step is %s by now starts nothing and disables itself',
		async (status) => {
			const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
			const stepId = randomUUID()
			const s = await seed({ step_id: stepId })
			await seedStep(s, stepId, status)

			expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')

			expect(createSession).not.toHaveBeenCalled()
			expect((await readTrigger(s.trigger.id)).enabled).toBe(false)
			const skipped = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, s.trigger.id), eq(events.action, 'trigger_skipped')))
			expect(skipped[0].data).toMatchObject({ reason: 'step_closed' })
		},
	)

	it('a reminder whose step row is gone starts nothing', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({ step_id: randomUUID() })

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')
		expect(createSession).not.toHaveBeenCalled()
	})

	it('a timer armed from an old copy does nothing when the reminder was moved later', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({ scheduled_at: minutesFromNow(30) })

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')

		expect(createSession).not.toHaveBeenCalled()
		expect((await readTrigger(s.trigger.id)).enabled).toBe(true)
	})

	it('a reminder with no step still fires when it is hours late', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({ scheduled_at: minutesFromNow(-300) })

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('fired')
		expect(createSession).toHaveBeenCalledOnce()
	})

	it('a reminder whose object is gone starts nothing and disables itself', async () => {
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const s = await seed({ object_id: randomUUID() })

		expect(await newRunner(createSession).fireReminder(s.trigger.id)).toBe('skipped')

		expect(createSession).not.toHaveBeenCalled()
		expect((await readTrigger(s.trigger.id)).enabled).toBe(false)
	})
})
