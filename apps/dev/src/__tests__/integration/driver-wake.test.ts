// A driver is woken when something it drives changes: its child tasks all close, a blocker clears,
// its object is moved by someone else, or a decision card it posted expires. A change the driver
// made itself wakes nobody, the same reason wakes it once an hour, and wakes that arrive together
// are merged into one session. Off unless the workspace has the driver-wake flag.

import { events, objects, sessions } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordEventReturning } from '../../lib/events/record-event'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { DRIVER_WOKEN_ACTION, DriverWaker } from '../../services/driver-wake'
import { SessionNotAdmittedError } from '../../services/self-start-limits'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

const { startSessionMock, captureMock } = vi.hoisted(() => ({
	startSessionMock: vi.fn(
		async (_input: {
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

const MINUTE = 60_000

describe('DriverWaker', () => {
	let workspaceId: string
	let ownerId: string
	let driverId: string
	let otherAgentId: string
	let waker: DriverWaker
	let previousFeatures: string | undefined

	const wokenEvents = () =>
		captureMock.mock.calls.filter((c) => c[0] === 'driver_woken').map((c) => c[2])

	function setFlag(on: boolean) {
		process.env.FF_WORKSPACE_FEATURES = on ? `${workspaceId}:driver-wake` : ''
		_resetFeatureFlagConfig()
	}

	beforeEach(async () => {
		captureMock.mockClear()
		startSessionMock.mockReset()
		previousFeatures = process.env.FF_WORKSPACE_FEATURES
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		driverId = (await insertActor(db, { type: 'agent', name: 'Driver' })).id
		otherAgentId = (await insertActor(db, { type: 'agent', name: 'Reviewer' })).id
		await ensureWorkspaceMember(db, workspaceId, driverId)
		await ensureWorkspaceMember(db, workspaceId, otherAgentId)
		setFlag(true)
		// Stand-in for the real startSession: inserts the live row the new session would have.
		startSessionMock.mockImplementation(async (input) => {
			const started = await insertSession(db, workspaceId, driverId, driverId, {
				status: 'running',
				config: input.config ?? {},
				initiatedFromObjectId: input.initiatedFromObjectId,
			})
			return { sessionId: started.id, state: 'queued', createdAt: new Date() }
		})
		// A plain emitter stands in for the bridge; the tests call the handlers directly.
		waker = new DriverWaker(db, { on() {}, off() {} } as unknown as PgNotifyBridge, {
			settleMs: 60 * MINUTE,
		})
	})

	afterEach(() => {
		waker.stop()
		if (previousFeatures === undefined) Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		else process.env.FF_WORKSPACE_FEATURES = previousFeatures
		_resetFeatureFlagConfig()
	})

	const makeObject = (type: string, status: string, driver: string | null = driverId) =>
		insertObject(db, workspaceId, ownerId, { type, status, driver })

	const link = (sourceId: string, targetId: string, type: 'breaks_into' | 'blocks') =>
		insertRelationship(db, ownerId, {
			sourceType: 'object',
			sourceId,
			targetType: 'object',
			targetId,
			type,
		})

	// A status change on `objectId` by `actorId`, as PATCH /objects writes it, handed to the waker.
	async function moved(objectId: string, type: string, from: string, to: string, actorId: string) {
		await db.update(objects).set({ status: to }).where(eq(objects.id, objectId))
		const row = await recordEventReturning(db, {
			workspaceId,
			actorId,
			action: 'status_changed',
			entityType: type,
			entityId: objectId,
			data: { changes: [{ field: 'status', old: from, new: to }] },
		})
		const event: PgEvent = {
			workspace_id: workspaceId,
			actor_id: actorId,
			action: 'status_changed',
			entity_type: type,
			entity_id: objectId,
			event_id: String(row.id),
		}
		await waker.onStatusChanged(event)
	}

	const flushAll = (driver: string, objectId: string) => waker.flush(`${driver}:${objectId}`)

	const wakeSessions = (objectId: string) =>
		db
			.select()
			.from(sessions)
			.where(and(eq(sessions.initiatedFromObjectId, objectId), eq(sessions.actorId, driverId)))

	it('wakes the parent driver once when the last child task closes', async () => {
		const bet = await makeObject('bet', 'active')
		const a = await makeObject('task', 'done', otherAgentId)
		const b = await makeObject('task', 'in_review', otherAgentId)
		const c = await makeObject('task', 'validated', otherAgentId)
		for (const t of [a, b, c]) await link(bet.id, t.id, 'breaks_into')

		await moved(b.id, 'task', 'in_review', 'done', otherAgentId)
		await flushAll(driverId, bet.id)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		const call = startSessionMock.mock.calls[0]?.[0]
		expect(call?.initiatedFromObjectId).toBe(bet.id)
		expect(call?.config).toMatchObject({
			start_reason: 'driver_wake',
			driver_wake: { reasons: ['child_tasks_closed'], changed_object_ids: [b.id] },
		})
		expect(call?.actionPrompt).toContain(bet.id)
		expect(call?.actionPrompt).toContain(b.id)
	})

	it('does not wake while another child task is open', async () => {
		const bet = await makeObject('bet', 'active')
		const a = await makeObject('task', 'in_progress', otherAgentId)
		const b = await makeObject('task', 'in_review', otherAgentId)
		for (const t of [a, b]) await link(bet.id, t.id, 'breaks_into')

		await moved(b.id, 'task', 'in_review', 'done', otherAgentId)
		await flushAll(driverId, bet.id)

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('wakes at once when a child task is discarded', async () => {
		const bet = await makeObject('bet', 'active')
		const a = await makeObject('task', 'in_progress', otherAgentId)
		const b = await makeObject('task', 'todo', otherAgentId)
		for (const t of [a, b]) await link(bet.id, t.id, 'breaks_into')

		await moved(b.id, 'task', 'todo', 'discarded', otherAgentId)
		await flushAll(driverId, bet.id)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
	})

	it('wakes the blocked object driver when its last blocker closes', async () => {
		const blocked = await makeObject('task', 'backlog')
		const first = await makeObject('task', 'done', otherAgentId)
		const second = await makeObject('task', 'in_review', otherAgentId)
		await link(first.id, blocked.id, 'blocks')
		await link(second.id, blocked.id, 'blocks')

		await moved(second.id, 'task', 'in_review', 'validated', otherAgentId)
		await flushAll(driverId, blocked.id)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0]?.[0].config).toMatchObject({
			driver_wake: { reasons: ['blocker_cleared'] },
		})
	})

	it('does not wake while another blocker is open', async () => {
		const blocked = await makeObject('task', 'backlog')
		const first = await makeObject('task', 'in_progress', otherAgentId)
		const second = await makeObject('task', 'in_review', otherAgentId)
		await link(first.id, blocked.id, 'blocks')
		await link(second.id, blocked.id, 'blocks')

		await moved(second.id, 'task', 'in_review', 'done', otherAgentId)
		await flushAll(driverId, blocked.id)

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('wakes the driver when someone else moves its object', async () => {
		const task = await makeObject('task', 'in_review')

		await moved(task.id, 'task', 'in_review', 'in_progress', otherAgentId)
		await flushAll(driverId, task.id)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0]?.[0].config).toMatchObject({
			driver_wake: { reasons: ['status_changed'] },
		})
	})

	it('wakes nobody for a change the driver made itself', async () => {
		const bet = await makeObject('bet', 'active')
		const task = await makeObject('task', 'in_review', driverId)
		await link(bet.id, task.id, 'breaks_into')

		await moved(task.id, 'task', 'in_review', 'done', driverId)
		await flushAll(driverId, bet.id)
		await flushAll(driverId, task.id)

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('wakes nobody when the driver is a person', async () => {
		const bet = await makeObject('bet', 'active', ownerId)
		const task = await makeObject('task', 'in_review', otherAgentId)
		await link(bet.id, task.id, 'breaks_into')

		await moved(task.id, 'task', 'in_review', 'done', otherAgentId)
		await flushAll(ownerId, bet.id)

		expect(startSessionMock).not.toHaveBeenCalled()
	})

	it('does nothing with the flag off', async () => {
		setFlag(false)
		const bet = await makeObject('bet', 'active')
		const task = await makeObject('task', 'in_review', otherAgentId)
		await link(bet.id, task.id, 'breaks_into')

		await moved(task.id, 'task', 'in_review', 'done', otherAgentId)
		await flushAll(driverId, bet.id)

		expect(startSessionMock).not.toHaveBeenCalled()
		expect(wokenEvents()).toHaveLength(0)
	})

	it('merges wakes for one object into one session', async () => {
		const bet = await makeObject('bet', 'active')
		const task = await makeObject('task', 'in_review', otherAgentId)
		await link(bet.id, task.id, 'breaks_into')
		await link(task.id, bet.id, 'blocks')

		await moved(task.id, 'task', 'in_review', 'done', otherAgentId)
		await flushAll(driverId, bet.id)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(startSessionMock.mock.calls[0]?.[0].config).toMatchObject({
			driver_wake: { reasons: expect.arrayContaining(['child_tasks_closed', 'blocker_cleared']) },
		})
	})

	it('keeps a wake while the driver has a run on the object, and sends it when the run ends', async () => {
		const task = await makeObject('task', 'in_review')
		const live = await insertSession(db, workspaceId, driverId, driverId, {
			status: 'running',
			initiatedFromObjectId: task.id,
			completedAt: null,
		})

		await moved(task.id, 'task', 'in_review', 'in_progress', otherAgentId)
		await flushAll(driverId, task.id)
		expect(startSessionMock).not.toHaveBeenCalled()

		await db
			.update(sessions)
			.set({ status: 'completed', completedAt: new Date() })
			.where(eq(sessions.id, live.id))
		await waker.onSessionEnded({
			workspace_id: workspaceId,
			actor_id: driverId,
			action: 'session_completed',
			entity_type: 'session',
			entity_id: live.id,
			event_id: '0',
		})

		expect(startSessionMock).toHaveBeenCalledTimes(1)
	})

	it('drops a wake when a trigger already started a run on the object', async () => {
		const task = await makeObject('task', 'in_review')

		await moved(task.id, 'task', 'in_review', 'todo', otherAgentId)
		await insertSession(db, workspaceId, driverId, driverId, {
			status: 'completed',
			initiatedFromObjectId: task.id,
			completedAt: new Date(),
			createdAt: new Date(Date.now() + 1000),
		})
		await flushAll(driverId, task.id)

		expect(startSessionMock).not.toHaveBeenCalled()
		expect(wokenEvents()).toEqual([
			expect.objectContaining({
				reason: 'status_changed',
				outcome: 'dropped_other_mechanism',
				drop_reason: 'run_already_started',
				agent_id: driverId,
				workspace_id: workspaceId,
			}),
		])
	})

	it('wakes the same driver for the same reason once an hour', async () => {
		const task = await makeObject('task', 'in_review')

		await moved(task.id, 'task', 'in_review', 'in_progress', otherAgentId)
		await flushAll(driverId, task.id)
		expect(startSessionMock).toHaveBeenCalledTimes(1)

		// The first run ends, then the object is moved again within the hour.
		await db
			.update(sessions)
			.set({ status: 'completed', completedAt: new Date() })
			.where(eq(sessions.initiatedFromObjectId, task.id))
		await moved(task.id, 'task', 'in_progress', 'in_review', otherAgentId)
		await flushAll(driverId, task.id)

		expect(startSessionMock).toHaveBeenCalledTimes(1)
		expect(wokenEvents()).toEqual([
			expect.objectContaining({ outcome: 'dropped_other_mechanism', drop_reason: 'rate_limited' }),
		])
	})

	it('drops a wake the self-start gate refuses', async () => {
		const task = await makeObject('task', 'in_review')
		startSessionMock.mockRejectedValueOnce(
			new SessionNotAdmittedError('continuation_cap', 'blocked', 'driver_wake', null, 'capped'),
		)

		await moved(task.id, 'task', 'in_review', 'in_progress', otherAgentId)
		await flushAll(driverId, task.id)

		expect(wokenEvents()).toEqual([
			expect.objectContaining({ outcome: 'dropped_other_mechanism', drop_reason: 'not_admitted' }),
		])
	})

	it('sends the outcome when the woken run ends', async () => {
		const task = await makeObject('task', 'in_review')
		await moved(task.id, 'task', 'in_review', 'in_progress', otherAgentId)
		await flushAll(driverId, task.id)
		const [woken] = await wakeSessions(task.id)
		expect(woken).toBeDefined()
		const [claim] = await db
			.select()
			.from(events)
			.where(and(eq(events.action, DRIVER_WOKEN_ACTION), eq(events.entityId, woken?.id ?? '')))
		expect(claim?.data).toMatchObject({ object_id: task.id, reason: 'status_changed' })
		expect(wokenEvents()).toHaveLength(0)

		const end = {
			workspace_id: workspaceId,
			actor_id: driverId,
			action: 'session_completed',
			entity_type: 'session',
			entity_id: woken?.id ?? '',
			event_id: '0',
		}
		// The run wrote nothing on the object.
		await db
			.update(sessions)
			.set({ status: 'completed', completedAt: new Date() })
			.where(eq(sessions.id, woken?.id ?? ''))
		await waker.onSessionEnded(end)
		expect(wokenEvents()).toEqual([
			expect.objectContaining({
				reason: 'status_changed',
				outcome: 'changed_nothing',
				source: 'state_change',
			}),
		])

		// A second end report for the same session sends nothing more.
		await waker.onSessionEnded(end)
		expect(wokenEvents()).toHaveLength(1)
	})

	it('reports changed_something when the run wrote on the object', async () => {
		const task = await makeObject('task', 'in_review')
		await moved(task.id, 'task', 'in_review', 'in_progress', otherAgentId)
		await flushAll(driverId, task.id)
		const [woken] = await wakeSessions(task.id)
		await recordEventReturning(db, {
			workspaceId,
			actorId: driverId,
			action: 'commented',
			entityType: 'object',
			entityId: task.id,
			data: { content: 'On it' },
		})
		await db
			.update(sessions)
			.set({ status: 'completed', completedAt: new Date() })
			.where(eq(sessions.id, woken?.id ?? ''))

		await waker.onSessionEnded({
			workspace_id: workspaceId,
			actor_id: driverId,
			action: 'session_completed',
			entity_type: 'session',
			entity_id: woken?.id ?? '',
			event_id: '0',
		})

		expect(wokenEvents()).toEqual([expect.objectContaining({ outcome: 'changed_something' })])
	})

	describe('decision cards', () => {
		const card = (objectId: string, expiresAt: Date, actorId = driverId) =>
			recordEventReturning(db, {
				workspaceId,
				actorId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: {
					content: 'Which way?',
					decision: {
						title: 'Pick one',
						options: [{ label: 'A' }, { label: 'B' }],
						expires_at: expiresAt.toISOString(),
					},
				},
			})

		it('wakes the driver when its card expires with no answer', async () => {
			const bet = await makeObject('bet', 'active')
			await card(bet.id, new Date(Date.now() + 10 * MINUTE))
			const scanner = new DriverWaker(db, { on() {}, off() {} } as unknown as PgNotifyBridge, {
				settleMs: 60 * MINUTE,
				now: () => new Date(Date.now() + 20 * MINUTE),
			})

			await scanner.scanExpiredDecisions()
			await scanner.flush(`${driverId}:${bet.id}`)
			scanner.stop()

			expect(startSessionMock).toHaveBeenCalledTimes(1)
			expect(startSessionMock.mock.calls[0]?.[0].config).toMatchObject({
				driver_wake: { reasons: ['decision_expired'] },
			})
		})

		it('does not wake for a card a person answered', async () => {
			const bet = await makeObject('bet', 'active')
			await card(bet.id, new Date(Date.now() + 10 * MINUTE))
			await recordEventReturning(db, {
				workspaceId,
				actorId: ownerId,
				action: 'commented',
				entityType: 'object',
				entityId: bet.id,
				data: { content: 'B' },
			})
			const scanner = new DriverWaker(db, { on() {}, off() {} } as unknown as PgNotifyBridge, {
				settleMs: 60 * MINUTE,
				now: () => new Date(Date.now() + 20 * MINUTE),
			})

			await scanner.scanExpiredDecisions()
			await scanner.flush(`${driverId}:${bet.id}`)
			scanner.stop()

			expect(startSessionMock).not.toHaveBeenCalled()
		})

		it('does not read any events when no workspace has the flag', async () => {
			setFlag(false)
			const select = vi.spyOn(db, 'select')

			await waker.scanExpiredDecisions()

			expect(select).not.toHaveBeenCalled()
			select.mockRestore()
		})

		it('does not wake for a card that has not expired', async () => {
			const bet = await makeObject('bet', 'active')
			await card(bet.id, new Date(Date.now() + 3 * 60 * MINUTE))

			await waker.scanExpiredDecisions()
			await waker.flush(`${driverId}:${bet.id}`)

			expect(startSessionMock).not.toHaveBeenCalled()
		})
	})
})
