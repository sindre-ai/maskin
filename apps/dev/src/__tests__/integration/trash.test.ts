import { randomUUID } from 'node:crypto'
import {
	agentSkills,
	files,
	objects,
	relationships,
	trash,
	triggers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	buildFile,
	buildWorkspaceSkill,
	insertActor,
	insertObject,
	insertRelationship,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: trashRoutes } = await import('../../routes/trash')
const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: filesRoutes } = await import('../../routes/files')
const { default: triggersRoutes } = await import('../../routes/triggers')
const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

/**
 * Trash — reversible deletes.
 *
 * A delete copies the row into `trash` and then deletes it, so a person can restore it
 * inside the 30 day window. A flow (an object of type 'loop') also has its in_loop edges
 * captured and removed, and a restore puts them back. Against real Postgres because the
 * behaviour is the FK-free edge cleanup and the jsonb row round-trip, which a mocked DB
 * cannot show.
 */
function createApp() {
	return createIntegrationApp(
		{ path: '/api/objects', module: objectsRoutes },
		{ path: '/api/trash', module: trashRoutes },
		{ path: '/api/relationships', module: relationshipsRoutes },
		{ path: '/api/files', module: filesRoutes },
		{ path: '/api/triggers', module: triggersRoutes },
		{ path: '/api/workspaces', module: workspaceSkillsRoutes },
	)
}

describe('Trash — reversible deletes', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	async function trashRows() {
		return db.select().from(trash).where(eq(trash.workspaceId, workspaceId))
	}

	it('copies a deleted object to the trash and restores it with its id', async () => {
		const object = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Undo me',
		})
		const app = createApp()

		const del = await app.request(
			jsonRequest('DELETE', `/api/objects/${object.id}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(del.status).toBe(200)
		expect(await db.select().from(objects).where(eq(objects.id, object.id))).toHaveLength(0)

		const entries = await trashRows()
		expect(entries).toHaveLength(1)
		expect(entries[0].kind).toBe('object')
		expect(entries[0].entityId).toBe(object.id)

		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entries[0].id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(200)

		const [back] = await db.select().from(objects).where(eq(objects.id, object.id))
		expect(back?.title).toBe('Undo me')
		expect(await trashRows()).toHaveLength(0)
	})

	it('captures and removes a flow in_loop edges, then restores them with the flow', async () => {
		const loop = await insertObject(db, workspaceId, actorId, { type: 'loop', title: 'A flow' })
		const memberA = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Member A',
		})
		const memberB = await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Member B',
		})
		for (const member of [memberA, memberB]) {
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: loop.id,
				targetType: 'object',
				targetId: member.id,
				type: 'in_loop',
			})
		}
		const app = createApp()

		const del = await app.request(
			jsonRequest('DELETE', `/api/objects/${loop.id}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(del.status).toBe(200)
		const delBody = (await del.json()) as { removed_member_object_ids?: string[] }
		expect((delBody.removed_member_object_ids ?? []).sort()).toEqual(
			[memberA.id, memberB.id].sort(),
		)

		const edgesAfterDelete = await db
			.select()
			.from(relationships)
			.where(and(eq(relationships.sourceId, loop.id), eq(relationships.type, 'in_loop')))
		expect(edgesAfterDelete).toHaveLength(0)

		const [entry] = await trashRows()
		expect(entry.kind).toBe('object')
		expect((entry.extra as { loop_membership?: unknown[] }).loop_membership).toHaveLength(2)

		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entry.id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(200)

		const [loopBack] = await db.select().from(objects).where(eq(objects.id, loop.id))
		expect(loopBack?.title).toBe('A flow')
		const edgesBack = await db
			.select()
			.from(relationships)
			.where(and(eq(relationships.sourceId, loop.id), eq(relationships.type, 'in_loop')))
		expect(edgesBack).toHaveLength(2)
		expect(await trashRows()).toHaveLength(0)
	})

	it('trashes and restores a deleted relationship', async () => {
		const object = await insertObject(db, workspaceId, actorId, { type: 'task', title: 'Linked' })
		const relationship = await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: object.id,
			targetType: 'object',
			targetId: randomUUID(),
			type: 'relates_to',
		})
		const app = createApp()

		const del = await app.request(
			jsonRequest('DELETE', `/api/relationships/${relationship.id}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(del.status).toBe(200)
		const [entry] = await trashRows()
		expect(entry.kind).toBe('relationship')

		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entry.id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(200)
		const [back] = await db
			.select()
			.from(relationships)
			.where(eq(relationships.id, relationship.id))
		expect(back).toBeTruthy()
	})

	it('trashes a deleted file row and restores it with the same id and dates', async () => {
		const [file] = await db
			.insert(files)
			.values(buildFile({ workspaceId, createdBy: actorId }))
			.returning()
		const app = createApp()

		const del = await app.request(
			jsonRequest('DELETE', `/api/files/${file.id}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(del.status).toBe(200)
		expect(await db.select().from(files).where(eq(files.id, file.id))).toHaveLength(0)

		const [entry] = await trashRows()
		expect(entry.kind).toBe('file')
		expect(entry.entityId).toBe(file.id)

		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entry.id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(200)

		const [back] = await db.select().from(files).where(eq(files.id, file.id))
		expect(back?.name).toBe(file.name)
		expect(back?.createdAt.getTime()).toBe(file.createdAt.getTime())
		expect(await trashRows()).toHaveLength(0)
	})

	it('restores a workspace skill together with its agent attachment', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Skill Agent' })
		const [skill] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId, createdBy: actorId }))
			.returning()
		const [attachment] = await db
			.insert(agentSkills)
			.values({ actorId: agent.id, workspaceSkillId: skill.id })
			.returning()
		const app = createApp()

		const del = await app.request(
			jsonRequest('DELETE', `/api/workspaces/${workspaceId}/skills/${skill.id}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(del.status).toBe(200)
		expect(
			await db.select().from(workspaceSkills).where(eq(workspaceSkills.id, skill.id)),
		).toHaveLength(0)
		expect(
			await db.select().from(agentSkills).where(eq(agentSkills.workspaceSkillId, skill.id)),
		).toHaveLength(0)

		const [entry] = await trashRows()
		expect(entry.kind).toBe('workspace_skill')

		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entry.id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(200)

		const [skillBack] = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, skill.id))
		expect(skillBack?.name).toBe(skill.name)
		const attachmentsBack = await db
			.select()
			.from(agentSkills)
			.where(eq(agentSkills.workspaceSkillId, skill.id))
		expect(attachmentsBack).toHaveLength(1)
		expect(attachmentsBack[0].actorId).toBe(agent.id)
		expect(attachmentsBack[0].createdAt.getTime()).toBe(attachment.createdAt.getTime())
	})

	it('restores a trigger into the flow steps it was pruned from', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Trigger Agent' })
		const trigger = await insertTrigger(db, workspaceId, actorId, agent.id)
		const flow = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			title: 'A flow with a step',
			metadata: { trigger_ids: [trigger.id] },
		})
		const app = createApp()

		const del = await app.request(
			jsonRequest('DELETE', `/api/triggers/${trigger.id}`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(del.status).toBe(200)
		expect(await db.select().from(triggers).where(eq(triggers.id, trigger.id))).toHaveLength(0)
		const [flowAfterDelete] = await db.select().from(objects).where(eq(objects.id, flow.id))
		expect((flowAfterDelete.metadata as { trigger_ids: string[] }).trigger_ids).toEqual([])

		const [entry] = await trashRows()
		expect(entry.kind).toBe('trigger')
		expect((entry.extra as { flow_ids?: string[] }).flow_ids).toEqual([flow.id])

		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entry.id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(200)

		const [triggerBack] = await db.select().from(triggers).where(eq(triggers.id, trigger.id))
		expect(triggerBack?.name).toBe(trigger.name)
		const [flowBack] = await db.select().from(objects).where(eq(objects.id, flow.id))
		expect((flowBack.metadata as { trigger_ids: string[] }).trigger_ids).toEqual([trigger.id])
		expect(await trashRows()).toHaveLength(0)
	})

	it('answers 404 for a trash entry in another workspace', async () => {
		const otherOwner = await insertActor(db, { type: 'human', name: 'Other Owner' })
		const otherWorkspace = await insertWorkspace(db, otherOwner.id)
		const [entry] = await db
			.insert(trash)
			.values({
				workspaceId: otherWorkspace.id,
				kind: 'object',
				entityId: randomUUID(),
				row: { id: randomUUID(), type: 'task', title: 'Elsewhere' },
				deletedBy: otherOwner.id,
				purgeAt: new Date(Date.now() + 86_400_000),
			})
			.returning()

		const app = createApp()
		const restore = await app.request(
			jsonRequest('POST', `/api/trash/${entry.id}/restore`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(restore.status).toBe(404)
	})
})
