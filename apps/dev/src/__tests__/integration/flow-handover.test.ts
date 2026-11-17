// A flow can opt in to "a handover is a task, a mention starts nothing". Off unless the flow's
// metadata says so, and never for the development team. A person's answer to a decision card
// reaches only the agent that asked it.

import { beforeEach, describe, expect, it } from 'vitest'
import { findDecisionCardAsker } from '../../lib/decision-card-asker'
import { recordEventReturning } from '../../lib/events/record-event'
import { mentionStartsNoRun } from '../../lib/flow-handover'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertRelationship,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

describe('mentionStartsNoRun', () => {
	let workspaceId: string
	let ownerId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
	})

	const inLoop = (loopId: string, objectId: string) =>
		insertRelationship(db, ownerId, {
			sourceType: 'object',
			sourceId: loopId,
			targetType: 'object',
			targetId: objectId,
			type: 'in_loop',
		})

	it('is false for an object in a flow that has not opted in', async () => {
		const loop = await insertObject(db, workspaceId, ownerId, { type: 'loop', status: 'live' })
		const event = await insertObject(db, workspaceId, ownerId, { type: 'event', status: 'planned' })
		await inLoop(loop.id, event.id)

		expect(
			await mentionStartsNoRun(db, {
				workspaceId,
				objectId: event.id,
				mentionedAgentName: 'Events Lead',
			}),
		).toBe(false)
	})

	it('is true for an object, or a task under an object, in a flow that opted in', async () => {
		const loop = await insertObject(db, workspaceId, ownerId, {
			type: 'loop',
			status: 'live',
			metadata: { handover_is_task: true },
		})
		const event = await insertObject(db, workspaceId, ownerId, { type: 'event', status: 'planned' })
		const task = await insertObject(db, workspaceId, ownerId, { type: 'task', status: 'todo' })
		await inLoop(loop.id, event.id)
		await insertRelationship(db, ownerId, {
			sourceType: 'object',
			sourceId: event.id,
			targetType: 'object',
			targetId: task.id,
			type: 'breaks_into',
		})

		for (const objectId of [event.id, task.id]) {
			expect(
				await mentionStartsNoRun(db, { workspaceId, objectId, mentionedAgentName: 'Events Lead' }),
			).toBe(true)
		}
	})

	it('is false for the development team even in a flow that opted in', async () => {
		const loop = await insertObject(db, workspaceId, ownerId, {
			type: 'loop',
			status: 'live',
			metadata: { handover_is_task: true },
		})
		const task = await insertObject(db, workspaceId, ownerId, { type: 'task', status: 'todo' })
		await inLoop(loop.id, task.id)

		expect(
			await mentionStartsNoRun(db, {
				workspaceId,
				objectId: task.id,
				mentionedAgentName: 'Developer',
			}),
		).toBe(false)
	})
})

describe('findDecisionCardAsker', () => {
	let workspaceId: string
	let ownerId: string
	let askerId: string
	let otherAgentId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		askerId = (await insertActor(db, { type: 'agent', name: 'Asker' })).id
		otherAgentId = (await insertActor(db, { type: 'agent', name: 'Other' })).id
		await ensureWorkspaceMember(db, workspaceId, askerId)
		await ensureWorkspaceMember(db, workspaceId, otherAgentId)
	})

	const comment = (objectId: string, actorId: string, data: Record<string, unknown>) =>
		recordEventReturning(db, {
			workspaceId,
			actorId,
			action: 'commented',
			entityType: 'object',
			entityId: objectId,
			data: { content: 'x', ...data },
		})

	it('returns the agent that posted the card, whether it is the thread root or a reply', async () => {
		const object = await insertObject(db, workspaceId, ownerId, { type: 'task', status: 'todo' })
		const root = await comment(object.id, otherAgentId, {})
		await comment(object.id, askerId, { parentEventId: root.id, decision: { title: 'Which?' } })

		expect(
			await findDecisionCardAsker(db, {
				workspaceId,
				objectId: object.id,
				threadRootEventId: root.id,
			}),
		).toBe(askerId)
	})

	it('returns null for a thread with no card, and for a card a person posted', async () => {
		const object = await insertObject(db, workspaceId, ownerId, { type: 'task', status: 'todo' })
		const plain = await comment(object.id, askerId, {})
		const byPerson = await comment(object.id, ownerId, { decision: { title: 'Which?' } })

		for (const root of [plain, byPerson]) {
			expect(
				await findDecisionCardAsker(db, {
					workspaceId,
					objectId: object.id,
					threadRootEventId: root.id,
				}),
			).toBeNull()
		}
	})
})
