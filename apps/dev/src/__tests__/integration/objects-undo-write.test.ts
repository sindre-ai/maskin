import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, objects, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_NAME } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const { default: objectsRoutes } = await import('../../routes/objects')

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/objects', objectsRoutes)
	return app
}

// Insert a KA agent + a "Knowledge Author write" event on a knowledge object,
// mimicking the shape apps/dev/src/routes/objects.ts writes for a real PATCH.
async function seedKAWrite(
	workspaceId: string,
	objectId: string,
	changes: Array<{ field: string; old: unknown; new: unknown }>,
	options?: { agentActorId?: string; action?: 'updated' | 'status_changed'; createdAt?: Date },
) {
	const agent =
		options?.agentActorId ??
		(
			await insertActor(db, {
				type: 'agent',
				name: DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_NAME,
				email: null,
			})
		).id
	const [row] = await db
		.insert(events)
		.values({
			workspaceId,
			actorId: agent,
			action: options?.action ?? 'updated',
			entityType: 'knowledge',
			entityId: objectId,
			data: { changes },
			...(options?.createdAt ? { createdAt: options.createdAt } : {}),
		})
		.returning()
	return { agentId: agent, event: row }
}

describe('Objects undo-write integration', () => {
	let workspaceId: string
	let ownerId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
	})

	it('reverses a KA title write, restores the object, and logs a reversal event', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company (new)',
			metadata: { provenance: 'writer', summary: 'About the company' },
		})

		const { event } = await seedKAWrite(workspaceId, knowledge.id, [
			{ field: 'title', old: 'Company (old)', new: 'Company (new)' },
		])

		const res = await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.title).toBe('Company (old)')

		const [afterRow] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		expect(afterRow.title).toBe('Company (old)')
		const meta = afterRow.metadata as Record<string, unknown>
		// Unrelated metadata survives the partial-field undo.
		expect(meta.summary).toBe('About the company')

		const reversalEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, knowledge.id), eq(events.action, 'knowledge_write_undone')))
		expect(reversalEvents).toHaveLength(1)
		const data = reversalEvents[0].data as { original_event_id: number }
		expect(data.original_event_id).toBe(event.id)
	})

	it('rejects undo when the referenced event was authored by a non-KA agent', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company',
			metadata: { provenance: 'writer' },
		})

		// Different agent — should fail the KA identity guard.
		const impostor = await insertActor(db, {
			type: 'agent',
			name: 'Not the Knowledge Author',
			email: null,
		})
		const { event } = await seedKAWrite(
			workspaceId,
			knowledge.id,
			[{ field: 'title', old: 'Company (old)', new: 'Company' }],
			{ agentActorId: impostor.id },
		)

		const res = await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)
		expect(res.status).toBe(409)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		expect(row.title).toBe('Company')
	})

	it('rejects undo when the event is older than the 7-day window', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company (new)',
			metadata: { provenance: 'writer' },
		})

		const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
		const { event } = await seedKAWrite(
			workspaceId,
			knowledge.id,
			[{ field: 'title', old: 'Company (old)', new: 'Company (new)' }],
			{ createdAt: staleDate },
		)

		const res = await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)
		expect(res.status).toBe(410)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		expect(row.title).toBe('Company (new)')
	})

	it('rejects undo from an agent workspace admin', async () => {
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Agent Admin',
			email: null,
		})
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: agent.id,
			role: 'admin',
		})

		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company (new)',
			metadata: { provenance: 'writer' },
		})
		const { event } = await seedKAWrite(workspaceId, knowledge.id, [
			{ field: 'title', old: 'Company (old)', new: 'Company (new)' },
		])

		const res = await appAs(agent.id).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)
		expect(res.status).toBe(403)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		expect(row.title).toBe('Company (new)')
	})

	it('rejects undo from a human member without an admin/owner role', async () => {
		const bystander = await insertActor(db, {
			type: 'human',
			name: 'Plain Member',
			email: 'plain-undo@test.com',
		})
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: bystander.id,
			role: 'member',
		})

		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company (new)',
			metadata: { provenance: 'writer' },
		})
		const { event } = await seedKAWrite(workspaceId, knowledge.id, [
			{ field: 'title', old: 'Company (old)', new: 'Company (new)' },
		])

		const res = await appAs(bystander.id).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)
		expect(res.status).toBe(403)
	})

	it('rejects undo of a `created` event (constraint: no object delete)', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company',
			metadata: { provenance: 'writer' },
		})
		const { event } = await seedKAWrite(
			workspaceId,
			knowledge.id,
			[{ field: 'title', old: null, new: 'Company' }],
			{ action: 'updated' },
		)
		// Overwrite the seeded action row-level to simulate a `created` timeline row.
		await db.update(events).set({ action: 'created' }).where(eq(events.id, event.id))

		const res = await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)
		expect(res.status).toBe(409)
	})

	it('leaves untouched fields intact under partial-field undo', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			title: 'Company (new)',
			content: 'later body edited by someone else',
			metadata: { provenance: 'writer', summary: 'A summary that must persist' },
		})
		const { event } = await seedKAWrite(workspaceId, knowledge.id, [
			{ field: 'title', old: 'Company (old)', new: 'Company (new)' },
		])

		const res = await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/undo-write`, { eventId: event.id }),
		)
		expect(res.status).toBe(200)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		expect(row.title).toBe('Company (old)')
		expect(row.content).toBe('later body edited by someone else')
		const meta = row.metadata as Record<string, unknown>
		expect(meta.summary).toBe('A summary that must persist')
	})

	// KA actor rows are seeded per-test; this cleanup keeps the shared test-actor
	// row unaffected while ensuring the agents we insert don't accumulate.
	// events.actor_id has an ON DELETE no action FK to actors, so the events
	// these agents authored must be deleted first or the actor delete violates
	// the constraint.
	afterEach(async () => {
		const kaAgents = await db
			.select({ id: actors.id })
			.from(actors)
			.where(eq(actors.name, DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_NAME))
		if (kaAgents.length > 0) {
			const ids = kaAgents.map((a) => a.id)
			await db.delete(events).where(inArray(events.actorId, ids))
			await db.delete(actors).where(eq(actors.name, DEV_PACKAGE_RETRO_KNOWLEDGE_AUTHOR_NAME))
		}
	})
})
