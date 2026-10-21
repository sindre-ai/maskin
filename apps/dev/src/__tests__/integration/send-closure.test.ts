import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { SendTargetError, assertSendable, recordSendOutcome } from '../../lib/send-closure'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * A send tool given the task it carries out ends that task. These need a real Postgres: the
 * point is the row lock plus the `status_changed` and `delivered` events written with the
 * status update, and the double-send guard reading the object's own event log.
 */

let workspaceId: string
let actorId: string

beforeEach(async () => {
	actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	workspaceId = ws.id
})

async function eventsFor(objectId: string, action: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.entityId, objectId), eq(events.action, action)))
}

async function statusOf(objectId: string) {
	const [row] = await db
		.select({ status: objects.status })
		.from(objects)
		.where(eq(objects.id, objectId))
	return row?.status
}

describe('recordSendOutcome', () => {
	it('moves a to-do task to done and records the send and the status change', async () => {
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		const target = await assertSendable(db, { workspaceId, objectId: task.id })

		const outcome = await recordSendOutcome(db, {
			workspaceId,
			actorId,
			target,
			provider: 'linkedin',
			data: { sent_at: '2026-10-21T10:50:00.000Z' },
		})

		expect(outcome).toEqual({ delivered: true, task_closed: true })
		expect(await statusOf(task.id)).toBe('done')
		const delivered = await eventsFor(task.id, 'delivered')
		expect(delivered).toHaveLength(1)
		expect(delivered[0].data).toMatchObject({ provider: 'linkedin' })
		const changed = await eventsFor(task.id, 'status_changed')
		expect(changed).toHaveLength(1)
		expect(JSON.stringify(changed[0].data)).toContain('done')
	})

	it('leaves a task that is already finished alone', async () => {
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'discarded' })
		const target = await assertSendable(db, { workspaceId, objectId: task.id })

		const outcome = await recordSendOutcome(db, {
			workspaceId,
			actorId,
			target,
			provider: 'linkedin',
		})

		expect(outcome).toEqual({ delivered: true, task_closed: false })
		expect(await statusOf(task.id)).toBe('discarded')
		expect(await eventsFor(task.id, 'status_changed')).toHaveLength(0)
	})

	it('records the send on a non-task object without changing its status', async () => {
		const insight = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		const target = await assertSendable(db, { workspaceId, objectId: insight.id })

		const outcome = await recordSendOutcome(db, {
			workspaceId,
			actorId,
			target,
			provider: 'linkedin',
		})

		expect(outcome).toEqual({ delivered: true, task_closed: false })
		expect(await statusOf(insight.id)).toBe('new')
		expect(await eventsFor(insight.id, 'delivered')).toHaveLength(1)
	})

	it('skips the delivered event when the caller wrote its own, and still closes the task', async () => {
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })

		const outcome = await recordSendOutcome(db, {
			workspaceId,
			actorId,
			target: { id: task.id, type: 'task' },
			provider: 'gmail',
			skipDeliveredEvent: true,
		})

		expect(outcome).toEqual({ delivered: true, task_closed: true })
		expect(await statusOf(task.id)).toBe('done')
		expect(await eventsFor(task.id, 'delivered')).toHaveLength(0)
	})

	it('does not throw when the record cannot be written', async () => {
		const outcome = await recordSendOutcome(db, {
			workspaceId,
			actorId,
			// An id that is not a uuid makes the insert fail, as a lost connection would.
			target: { id: 'not-a-uuid', type: 'task' },
			provider: 'linkedin',
		})

		expect(outcome).toEqual({ delivered: false, task_closed: false })
	})
})

describe('assertSendable', () => {
	it('refuses an object that does not exist in the workspace', async () => {
		const other = await insertWorkspace(db, actorId)
		const task = await insertObject(db, other.id, actorId, { type: 'task', status: 'todo' })

		await expect(assertSendable(db, { workspaceId, objectId: task.id })).rejects.toMatchObject({
			name: 'SendTargetError',
			code: 'NOT_FOUND',
		})
	})

	it('refuses a second send of the same object, whatever text the second one has', async () => {
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		const target = await assertSendable(db, { workspaceId, objectId: task.id })
		await recordSendOutcome(db, { workspaceId, actorId, target, provider: 'linkedin' })

		const second = assertSendable(db, { workspaceId, objectId: task.id })

		await expect(second).rejects.toBeInstanceOf(SendTargetError)
		await expect(second).rejects.toMatchObject({ code: 'ALREADY_SENT' })
	})
})
