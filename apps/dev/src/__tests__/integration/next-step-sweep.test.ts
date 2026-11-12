// The sweep for overdue or missing next steps (bet "Agents take the lead", rule 4). It finds a
// covered object whose step is overdue or missing, claims it once per hour across instances, and
// wakes the driver through startSession. In its first 3 days in a workspace it only records what it
// would have woken. Off unless the workspace has the next-step-sweep flag.

import { events, nextStepSweepClaims, nextSteps, objects, sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordEventReturning } from '../../lib/events/record-event'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { readPrecheckFacts } from '../../lib/heartbeat-precheck'
import { MAX_WAKES_PER_AGENT_PER_TICK, NextStepSweep } from '../../services/next-step-sweep'
import { SessionNotAdmittedError } from '../../services/self-start-limits'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { startSessionMock, captureMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(
		async (_input: {
			actorId: string
			actionPrompt?: string
			config?: Record<string, unknown>
			initiatedFromObjectId: string | null
		}) => ({ sessionId: '', state: 'queued', createdAt: new Date() }),
	),
	captureMock: vi.fn(async (_event: string, _id: string, _props: Record<string, unknown>) => {}),
}))

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: startSessionMock,
}))

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('NextStepSweep', () => {
	let workspaceId: string
	let ownerId: string
	let driverId: string
	let previousFeatures: string | undefined

	const woken = () => captureMock.mock.calls.filter((c) => c[0] === 'driver_woken').map((c) => c[2])
	const claims = () =>
		db.select().from(nextStepSweepClaims).where(eq(nextStepSweepClaims.workspaceId, workspaceId))
	const sweep = () => new NextStepSweep(db)

	function setFlags(...flags: string[]) {
		process.env.FF_WORKSPACE_FEATURES = flags.map((f) => `${workspaceId}:${f}`).join(',')
		_resetFeatureFlagConfig()
	}

	// Makes the sweep think it has been recording in this workspace for `ageMs`.
	async function recordedFor(ageMs: number) {
		const [anyClaim] = await claims()
		if (!anyClaim) throw new Error('nothing recorded yet')
		await db
			.update(nextStepSweepClaims)
			.set({ createdAt: new Date(Date.now() - ageMs) })
			.where(eq(nextStepSweepClaims.workspaceId, workspaceId))
	}

	// A bet the driver drives, quiet for 3 hours, with an open step that fell due an hour ago.
	async function overdueBet(driver = driverId) {
		const bet = await insertObject(db, workspaceId, ownerId, {
			type: 'bet',
			status: 'active',
			driver,
		})
		await db
			.update(objects)
			.set({ updatedAt: new Date(Date.now() - 3 * HOUR) })
			.where(eq(objects.id, bet.id))
		await db.insert(nextSteps).values({
			workspaceId,
			objectId: bet.id,
			action: 'Check the numbers',
			ownerActorId: driver,
			dueAt: new Date(Date.now() - HOUR),
		})
		return bet
	}

	// A bet the driver drives with no step at all, untouched for 3 hours.
	async function stepLessBet(updatedAgo = 3 * HOUR) {
		const bet = await insertObject(db, workspaceId, ownerId, {
			type: 'bet',
			status: 'active',
			driver: driverId,
		})
		await db
			.update(objects)
			.set({ updatedAt: new Date(Date.now() - updatedAgo) })
			.where(eq(objects.id, bet.id))
		return bet
	}

	beforeEach(async () => {
		captureMock.mockClear()
		startSessionMock.mockReset()
		previousFeatures = process.env.FF_WORKSPACE_FEATURES
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		driverId = (await insertActor(db, { type: 'agent', name: 'Driver' })).id
		await ensureWorkspaceMember(db, workspaceId, driverId)
		startSessionMock.mockImplementation(async (input) => {
			const started = await insertSession(db, workspaceId, driverId, driverId, {
				status: 'running',
				config: input.config ?? {},
				initiatedFromObjectId: input.initiatedFromObjectId,
			})
			return { sessionId: started.id, state: 'queued', createdAt: new Date() }
		})
	})

	afterEach(() => {
		if (previousFeatures === undefined) Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		else process.env.FF_WORKSPACE_FEATURES = previousFeatures
		_resetFeatureFlagConfig()
	})

	it('does nothing without the flag', async () => {
		await overdueBet()
		setFlags()
		await sweep().sweepWorkspace(workspaceId)
		expect(await claims()).toHaveLength(0)
		expect(startSessionMock).not.toHaveBeenCalled()
		expect(woken()).toHaveLength(0)
	})

	it('only records with the sweep flag: a claim row and an event, no run', async () => {
		const bet = await overdueBet()
		setFlags('next-step-sweep')

		await sweep().sweepWorkspace(workspaceId)

		expect(startSessionMock).not.toHaveBeenCalled()
		expect(await claims()).toEqual([
			expect.objectContaining({ objectId: bet.id, reason: 'step_overdue', mode: 'recorded' }),
		])
		expect(woken()).toEqual([
			expect.objectContaining({
				source: 'sweep',
				reason: 'step_overdue',
				outcome: 'recorded_only',
			}),
		])
	})

	it('records the same object once per day, not on every tick', async () => {
		await overdueBet()
		setFlags('next-step-sweep')
		await sweep().sweepWorkspace(workspaceId)
		await sweep().sweepWorkspace(workspaceId)
		expect(await claims()).toHaveLength(1)
		expect(woken()).toHaveLength(1)
	})

	it('starts nothing in the first 3 days even with the wake flag on', async () => {
		await overdueBet()
		setFlags('next-step-sweep', 'next-step-sweep-wake')

		await sweep().sweepWorkspace(workspaceId)
		await recordedFor(2 * DAY)
		await sweep().sweepWorkspace(workspaceId)

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('wakes the driver of an overdue step after 3 days of recording, once per hour', async () => {
		const bet = await overdueBet()
		setFlags('next-step-sweep', 'next-step-sweep-wake')
		await sweep().sweepWorkspace(workspaceId)
		await recordedFor(4 * DAY)

		await sweep().sweepWorkspace(workspaceId)
		await sweep().sweepWorkspace(workspaceId)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		const call = startSessionMock.mock.calls[0]?.[0]
		expect(call?.actorId).toBe(driverId)
		expect(call?.initiatedFromObjectId).toBe(bet.id)
		expect(call?.config).toMatchObject({
			start_reason: 'sweep',
			driver_wake: { source: 'sweep', reasons: ['step_overdue'] },
		})
		expect(call?.actionPrompt).toContain('Check the numbers')
		const [row] = await db.select().from(nextSteps).where(eq(nextSteps.objectId, bet.id))
		expect(row?.wakeCount).toBe(1)
		expect(row?.lastWokenAt).not.toBeNull()
		const [woke] = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'driver_woken')))
		expect(woke?.data).toMatchObject({ object_id: bet.id, reason: 'step_overdue' })
	})

	it('the wake flag alone does nothing', async () => {
		await overdueBet()
		setFlags('next-step-sweep-wake')
		await sweep().sweepWorkspace(workspaceId)
		expect(await claims()).toHaveLength(0)
		expect(startSessionMock).not.toHaveBeenCalled()
	})

	describe('what it leaves alone', () => {
		beforeEach(async () => {
			// The sweep has been recording in this workspace for 4 days, and the wake flag is on.
			setFlags('next-step-sweep', 'next-step-sweep-wake')
			const old = await insertObject(db, workspaceId, ownerId, { type: 'task', status: 'done' })
			await db.insert(nextStepSweepClaims).values({
				workspaceId,
				objectId: old.id,
				driverActorId: driverId,
				reason: 'no_next_step',
				bucketStart: new Date(Date.now() - 4 * DAY),
				mode: 'recorded',
				createdAt: new Date(Date.now() - 4 * DAY),
			})
		})

		it('a step that is not late, and a blocked one', async () => {
			const early = await stepLessBet()
			await db.insert(nextSteps).values({
				workspaceId,
				objectId: early.id,
				action: 'Later',
				ownerActorId: driverId,
				dueAt: new Date(Date.now() + HOUR),
			})
			const waiting = await insertObject(db, workspaceId, ownerId, {
				type: 'task',
				status: 'in_progress',
			})
			const blocked = await stepLessBet()
			await db.insert(nextSteps).values({
				workspaceId,
				objectId: blocked.id,
				action: 'Waits',
				ownerActorId: driverId,
				dueAt: new Date(Date.now() - HOUR),
				status: 'blocked',
				blockedOnObjectId: waiting.id,
			})

			await sweep().sweepWorkspace(workspaceId)

			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('an object with no step that was touched in the last 2 hours', async () => {
			await stepLessBet(30 * 60_000)
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('wakes an object with no step that has been quiet for 2 hours', async () => {
			const bet = await stepLessBet()
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).toHaveBeenCalledTimes(1)
			expect(startSessionMock.mock.calls[0]?.[0].initiatedFromObjectId).toBe(bet.id)
			expect(startSessionMock.mock.calls[0]?.[0].config).toMatchObject({
				driver_wake: { reasons: ['no_next_step'] },
			})
		})

		it('an object that already has a run on it', async () => {
			const bet = await overdueBet()
			await insertSession(db, workspaceId, driverId, driverId, {
				status: 'running',
				initiatedFromObjectId: bet.id,
			})
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('an object whose active session is still running, even if it was not started from it', async () => {
			const bet = await overdueBet()
			const running = await insertSession(db, workspaceId, driverId, driverId, {
				status: 'running',
				initiatedFromObjectId: null,
			})
			await db.update(objects).set({ activeSessionId: running.id }).where(eq(objects.id, bet.id))
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('wakes an object whose active session field points at a session that has ended', async () => {
			const bet = await overdueBet()
			const ended = await insertSession(db, workspaceId, driverId, driverId, {
				status: 'completed',
				completedAt: new Date(Date.now() - 3 * HOUR),
				initiatedFromObjectId: null,
			})
			await db.update(objects).set({ activeSessionId: ended.id }).where(eq(objects.id, bet.id))
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).toHaveBeenCalledTimes(1)
		})

		it('an object a run started on within the hour', async () => {
			const bet = await overdueBet()
			await insertSession(db, workspaceId, driverId, driverId, {
				status: 'completed',
				completedAt: new Date(),
				initiatedFromObjectId: bet.id,
			})
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('an object where the driver has a live decision card', async () => {
			const bet = await overdueBet()
			await recordEventReturning(db, {
				workspaceId,
				actorId: driverId,
				action: 'commented',
				entityType: 'object',
				entityId: bet.id,
				data: {
					content: 'Which way?',
					decision: { title: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
				},
			})
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('wakes again once a person has answered the card', async () => {
			const bet = await overdueBet()
			const card = await recordEventReturning(db, {
				workspaceId,
				actorId: driverId,
				action: 'commented',
				entityType: 'object',
				entityId: bet.id,
				data: {
					content: 'Which way?',
					decision: { title: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
				},
			})
			await recordEventReturning(db, {
				workspaceId,
				actorId: ownerId,
				action: 'commented',
				entityType: 'object',
				entityId: bet.id,
				data: { content: 'A' },
			})
			expect(card.id).toBeGreaterThan(0)
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).toHaveBeenCalledTimes(1)
		})

		it('an object driven by a person, and a task', async () => {
			await insertObject(db, workspaceId, ownerId, {
				type: 'bet',
				status: 'active',
				driver: ownerId,
				updatedAt: new Date(Date.now() - 5 * HOUR),
			})
			await insertObject(db, workspaceId, ownerId, {
				type: 'task',
				status: 'in_progress',
				driver: driverId,
				updatedAt: new Date(Date.now() - 5 * HOUR),
			})
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it(`wakes one agent for at most ${MAX_WAKES_PER_AGENT_PER_TICK} objects in a tick`, async () => {
			for (let i = 0; i < MAX_WAKES_PER_AGENT_PER_TICK + 2; i++) await overdueBet()
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).toHaveBeenCalledTimes(MAX_WAKES_PER_AGENT_PER_TICK)
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).toHaveBeenCalledTimes(MAX_WAKES_PER_AGENT_PER_TICK + 2)
		})

		it('does not retry an object the limits refused, and says so', async () => {
			const bet = await overdueBet()
			startSessionMock.mockRejectedValue(
				new SessionNotAdmittedError(
					'no_change_backoff',
					'deferred',
					'sweep',
					new Date(Date.now() + HOUR),
					'wait',
				),
			)
			await sweep().sweepWorkspace(workspaceId)
			await sweep().sweepWorkspace(workspaceId)

			expect(startSessionMock).toHaveBeenCalledTimes(1)
			const rows = await db
				.select()
				.from(nextStepSweepClaims)
				.where(eq(nextStepSweepClaims.objectId, bet.id))
			expect(rows).toEqual([expect.objectContaining({ mode: 'refused' })])
			expect(woken()).toEqual([
				expect.objectContaining({
					outcome: 'dropped_other_mechanism',
					drop_reason: 'not_admitted',
					source: 'sweep',
				}),
			])
		})

		it('tries again next tick when the start failed for another reason', async () => {
			const bet = await overdueBet()
			startSessionMock.mockRejectedValueOnce(new Error('database blip'))
			await sweep().sweepWorkspace(workspaceId)
			expect(
				await db.select().from(nextStepSweepClaims).where(eq(nextStepSweepClaims.objectId, bet.id)),
			).toHaveLength(0)
			await sweep().sweepWorkspace(workspaceId)
			expect(startSessionMock).toHaveBeenCalledTimes(2)
		})

		it('two server instances never start two runs for one step', async () => {
			await overdueBet()
			await Promise.all([sweep().sweepWorkspace(workspaceId), sweep().sweepWorkspace(workspaceId)])
			const live = await db
				.select()
				.from(sessions)
				.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.actorId, driverId)))
			expect(live.length).toBeLessThanOrEqual(1)
			expect(startSessionMock.mock.calls.length).toBeLessThanOrEqual(1)
		})
	})
})

describe('heartbeat pre-check facts', () => {
	let workspaceId: string
	let ownerId: string
	let agentId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Owner' })).id
		await ensureWorkspaceMember(db, workspaceId, agentId)
	})

	const heartbeat = () => insertTrigger(db, workspaceId, agentId, agentId, { type: 'cron' })

	async function fired(triggerId: string, ago: number) {
		const row = await recordEventReturning(db, {
			workspaceId,
			actorId: agentId,
			action: 'trigger_fired',
			entityType: 'trigger',
			entityId: triggerId,
			data: {},
		})
		await db
			.update(events)
			.set({ createdAt: new Date(Date.now() - ago) })
			.where(eq(events.id, row.id))
	}

	it('counts an overdue step and an object with no step', async () => {
		const trigger = await heartbeat()
		await insertObject(db, workspaceId, ownerId, { type: 'loop', status: 'live', driver: agentId })
		const facts = await readPrecheckFacts(db, trigger, new Date())
		expect(facts.missing).toBe(1)
		expect(facts.overdue).toBe(0)
	})

	it('counts a comment from someone else since the last run, not one before it', async () => {
		const trigger = await heartbeat()
		const bet = await insertObject(db, workspaceId, ownerId, {
			type: 'bet',
			status: 'active',
			driver: agentId,
		})
		await fired(trigger.id, 6 * HOUR)
		const old = await recordEventReturning(db, {
			workspaceId,
			actorId: ownerId,
			action: 'commented',
			entityType: 'object',
			entityId: bet.id,
			data: { content: 'earlier' },
		})
		await db
			.update(events)
			.set({ createdAt: new Date(Date.now() - 12 * HOUR) })
			.where(eq(events.id, old.id))
		expect((await readPrecheckFacts(db, trigger, new Date())).otherActorEvents).toBe(0)

		await recordEventReturning(db, {
			workspaceId,
			actorId: ownerId,
			action: 'commented',
			entityType: 'object',
			entityId: bet.id,
			data: { content: 'new customer comment' },
		})
		expect((await readPrecheckFacts(db, trigger, new Date())).otherActorEvents).toBe(1)
	})

	it('counts a new insight linked to something a flow it drives contains', async () => {
		const trigger = await heartbeat()
		const loop = await insertObject(db, workspaceId, ownerId, {
			type: 'loop',
			status: 'live',
			driver: agentId,
		})
		const task = await insertObject(db, workspaceId, ownerId, { type: 'task', status: 'todo' })
		await insertRelationship(db, ownerId, {
			sourceType: 'object',
			sourceId: loop.id,
			targetType: 'object',
			targetId: task.id,
			type: 'in_loop',
		})
		await fired(trigger.id, 6 * HOUR)
		expect((await readPrecheckFacts(db, trigger, new Date())).newInsights).toBe(0)

		const insight = await insertObject(db, workspaceId, ownerId, { type: 'insight', status: 'new' })
		await insertRelationship(db, ownerId, {
			sourceType: 'object',
			sourceId: insight.id,
			targetType: 'object',
			targetId: task.id,
			type: 'relates_to',
		})
		expect((await readPrecheckFacts(db, trigger, new Date())).newInsights).toBe(1)
	})
})
