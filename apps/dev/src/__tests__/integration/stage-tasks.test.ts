// A flow stage's standard tasks are created when an object enters the stage: moved to a status, or
// added to a flow while already in one. Each task gets its owner as driver (the flow's driver when
// the owner is blank or unknown), a due date, the done test and a breaks_into edge from the object.
// A replay adds nothing, a flow that is not running does nothing, and a move to greenlit still
// fires the stage trigger beside it.

import { objects, relationships } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordEventReturning } from '../../lib/events/record-event'
import { StageTaskCreator } from '../../services/stage-tasks'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertRelationship,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'
import { newQueueRunner, pollUntil } from './queue-helpers'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const DAY = 86_400_000

const LIST = [
	'Book the room | Events Lead | +2d | The booking is linked on the event',
	'Confirm the venue | Events Lead | +12h',
	'Send the invite | | | The invite is sent',
	'Order the badges | Nobody Here | +3d | The order is confirmed',
]

describe('StageTaskCreator', () => {
	let workspaceId: string
	let ownerId: string
	let flowDriverId: string
	let eventsLeadId: string
	let creator: StageTaskCreator

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		flowDriverId = (await insertActor(db, { type: 'agent', name: 'Flow Driver' })).id
		eventsLeadId = (await insertActor(db, { type: 'agent', name: 'Events Lead' })).id
		await ensureWorkspaceMember(db, workspaceId, flowDriverId)
		await ensureWorkspaceMember(db, workspaceId, eventsLeadId)
		// A plain emitter stands in for the bridge; the tests call the handlers directly.
		creator = new StageTaskCreator(db, { on() {}, off() {} } as unknown as PgNotifyBridge)
	})

	const makeFlow = (lists: Record<string, string[]>, status = 'supervised') =>
		insertObject(db, workspaceId, ownerId, {
			type: 'loop',
			title: 'Events flow',
			status,
			driver: flowDriverId,
			metadata: { stage_tasks: lists },
		})

	const makeEvent = (status = 'greenlit') =>
		insertObject(db, workspaceId, ownerId, { type: 'event', title: '25 Nov webinar', status })

	const join = (flowId: string, memberId: string) =>
		insertRelationship(db, ownerId, {
			sourceType: 'object',
			sourceId: flowId,
			targetType: 'object',
			targetId: memberId,
			type: 'in_loop',
		})

	// A status change on `objectId`, as PATCH /objects writes it.
	async function moveTo(objectId: string, type: string, from: string, to: string) {
		await db.update(objects).set({ status: to }).where(eq(objects.id, objectId))
		const row = await recordEventReturning(db, {
			workspaceId,
			actorId: ownerId,
			action: 'status_changed',
			entityType: type,
			entityId: objectId,
			data: { changes: [{ field: 'status', old: from, new: to }] },
		})
		return {
			workspace_id: workspaceId,
			actor_id: ownerId,
			action: 'status_changed',
			entity_type: type,
			entity_id: objectId,
			event_id: String(row.id),
		} satisfies PgEvent
	}

	// An object added to a flow, as POST /relationships writes it.
	async function addedTo(flowId: string, memberId: string) {
		const edge = await join(flowId, memberId)
		const row = await recordEventReturning(db, {
			workspaceId,
			actorId: ownerId,
			action: 'created',
			entityType: 'relationship',
			entityId: edge.id,
			data: edge,
		})
		return {
			workspace_id: workspaceId,
			actor_id: ownerId,
			action: 'created',
			entity_type: 'relationship',
			entity_id: edge.id,
			event_id: String(row.id),
		} satisfies PgEvent
	}

	const tasksOf = (flowId: string) =>
		db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'task'),
					sql`${objects.metadata}->>'flow_id' = ${flowId}`,
				),
			)

	const byTitle = async (flowId: string, title: string) => {
		const task = (await tasksOf(flowId)).find((t) => t.title === title)
		if (!task) throw new Error(`no task titled ${title}`)
		return task
	}

	it('creates the listed tasks with owner, due date, done test and link when an object enters the stage', async () => {
		const flow = await makeFlow({ 'event:greenlit': LIST })
		const event = await makeEvent('proposed')
		await join(flow.id, event.id)

		await creator.onStatusChanged(await moveTo(event.id, 'event', 'proposed', 'greenlit'))

		const tasks = await tasksOf(flow.id)
		expect(tasks.map((t) => t.title).sort()).toEqual(
			['Book the room', 'Confirm the venue', 'Order the badges', 'Send the invite'].sort(),
		)

		const room = await byTitle(flow.id, 'Book the room')
		expect(room.driver).toBe(eventsLeadId)
		expect(room.status).toBe('backlog')
		expect(room.content).toContain('**Done when:** The booking is linked on the event')
		expect(room.metadata).toMatchObject({
			source: 'stage_task',
			stage: 'greenlit',
			flow_id: flow.id,
			done_test: 'The booking is linked on the event',
		})
		const dueIn = Date.parse(String((room.metadata as Record<string, unknown>).due_at)) - Date.now()
		expect(Math.abs(dueIn - 2 * DAY)).toBeLessThan(60_000)

		// Due within a day, or with no date, is ready now so the owner is woken.
		expect((await byTitle(flow.id, 'Confirm the venue')).status).toBe('todo')
		expect((await byTitle(flow.id, 'Send the invite')).status).toBe('todo')

		const edges = await db
			.select()
			.from(relationships)
			.where(and(eq(relationships.sourceId, event.id), eq(relationships.type, 'breaks_into')))
		expect(edges.map((e) => e.targetId).sort()).toEqual(tasks.map((t) => t.id).sort())
	})

	it('falls back to the flow driver for a blank, unknown or foreign owner', async () => {
		// An agent of that name exists, but it is not a member of this workspace.
		await insertActor(db, { type: 'agent', name: 'Outsider' })
		const flow = await makeFlow({
			'event:greenlit': [...LIST, 'Call the press | Outsider | +1d'],
		})
		const event = await makeEvent('proposed')
		await join(flow.id, event.id)

		await creator.onStatusChanged(await moveTo(event.id, 'event', 'proposed', 'greenlit'))

		expect((await byTitle(flow.id, 'Send the invite')).driver).toBe(flowDriverId)
		expect((await byTitle(flow.id, 'Order the badges')).driver).toBe(flowDriverId)
		expect((await byTitle(flow.id, 'Call the press')).driver).toBe(flowDriverId)
	})

	it('adds nothing when the same event is replayed, here or on a second server', async () => {
		const flow = await makeFlow({ 'event:greenlit': LIST })
		const event = await makeEvent('proposed')
		await join(flow.id, event.id)
		const moved = await moveTo(event.id, 'event', 'proposed', 'greenlit')
		const second = new StageTaskCreator(db, { on() {}, off() {} } as unknown as PgNotifyBridge)

		await creator.onStatusChanged(moved)
		await creator.onStatusChanged(moved)
		await Promise.all([creator.onStatusChanged(moved), second.onStatusChanged(moved)])

		expect(await tasksOf(flow.id)).toHaveLength(LIST.length)
		const edges = await db
			.select()
			.from(relationships)
			.where(and(eq(relationships.sourceId, event.id), eq(relationships.type, 'breaks_into')))
		expect(edges).toHaveLength(LIST.length)
	})

	it('does nothing for a flow that is not running, or a stage with no list', async () => {
		const paused = await makeFlow({ 'event:greenlit': LIST }, 'paused')
		const draft = await makeFlow({ 'event:greenlit': LIST }, 'draft')
		const other = await makeFlow({ 'event:wrapped_up': LIST })
		const event = await makeEvent('proposed')
		for (const flow of [paused, draft, other]) await join(flow.id, event.id)

		await creator.onStatusChanged(await moveTo(event.id, 'event', 'proposed', 'greenlit'))

		for (const flow of [paused, draft, other]) expect(await tasksOf(flow.id)).toHaveLength(0)
	})

	it('gives an object added to a flow already in a stage only that flow tasks', async () => {
		const first = await makeFlow({ 'event:greenlit': ['Book the room | Events Lead | +2d'] })
		const second = await makeFlow({ 'event:greenlit': ['Send the invite'] })
		const event = await makeEvent('greenlit')
		await join(second.id, event.id)

		await creator.onAddedToFlow(await addedTo(first.id, event.id))

		expect((await tasksOf(first.id)).map((t) => t.title)).toEqual(['Book the room'])
		expect(await tasksOf(second.id)).toHaveLength(0)
	})

	it('still fires the stage trigger on a move to greenlit, and creates the list in the same move', async () => {
		const flow = await makeFlow({ 'event:greenlit': LIST })
		const event = await makeEvent('proposed')
		await join(flow.id, event.id)
		const drafter = await insertActor(db, { type: 'agent', name: 'Event Drafter' })
		await insertTrigger(db, workspaceId, ownerId, drafter.id, {
			name: 'Draft the greenlit event',
			type: 'event',
			config: { entity_type: 'event', action: 'status_changed', to_status: 'greenlit' },
		})
		const harness = newQueueRunner()
		const live = new StageTaskCreator(db, harness.bridge)
		await harness.runner.start()
		live.start()
		try {
			const moved = await moveTo(event.id, 'event', 'proposed', 'greenlit')
			harness.bridge.emit('event', moved)

			await pollUntil(() => harness.dispatches.length === 1)
			await pollUntil(async () => (await tasksOf(flow.id)).length === LIST.length)
			expect(harness.dispatches[0]).toEqual({
				actorId: drafter.id,
				eventId: Number(moved.event_id),
			})
		} finally {
			live.stop()
			await harness.runner.stop()
		}
	})
})
