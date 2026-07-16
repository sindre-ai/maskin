import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
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

// Builds a fresh Hono app that authenticates as the given actor. Distinct
// from the shared `createIntegrationApp` helper because we need to swap the
// caller identity per-test (owner, plain member, agent) to exercise the
// human-admin/owner guard.
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

describe('Objects verification integration', () => {
	let workspaceId: string
	let ownerId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
	})

	it('stamps then unstamps verification, persisting state via metadata and events', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			metadata: {
				provenance: 'writer',
				summary: 'About the company',
			},
		})

		const app = appAs(ownerId)

		// Stamp
		const stampRes = await app.request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/verification`, { verified: true }),
		)
		expect(stampRes.status).toBe(200)
		const stampBody = await stampRes.json()
		expect(stampBody.metadata.verified_by).toBe(ownerId)
		expect(typeof stampBody.metadata.verified_at).toBe('string')

		const [afterStamp] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		const stampMeta = afterStamp.metadata as Record<string, unknown>
		expect(stampMeta.verified_by).toBe(ownerId)
		expect(typeof stampMeta.verified_at).toBe('string')
		expect(stampMeta.provenance).toBe('writer')
		expect(stampMeta.summary).toBe('About the company')

		const verifyEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, knowledge.id), eq(events.action, 'verified')))
		expect(verifyEvents).toHaveLength(1)
		expect(verifyEvents[0].entityType).toBe('knowledge')

		// Unstamp
		const unstampRes = await app.request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/verification`, { verified: false }),
		)
		expect(unstampRes.status).toBe(200)
		const unstampBody = await unstampRes.json()
		expect(unstampBody.metadata.verified_by).toBeUndefined()
		expect(unstampBody.metadata.verified_at).toBeUndefined()

		const [afterUnstamp] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		const unstampMeta = afterUnstamp.metadata as Record<string, unknown>
		expect(unstampMeta.verified_by).toBeUndefined()
		expect(unstampMeta.verified_at).toBeUndefined()
		expect(unstampMeta.provenance).toBe('writer')

		const reversalEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, knowledge.id), eq(events.action, 'unverified')))
		expect(reversalEvents).toHaveLength(1)
	})

	it('rejects verification on a non-Knowledge-Author write with 409', async () => {
		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			metadata: { provenance: 'human-review' },
		})

		const res = await appAs(ownerId).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/verification`, { verified: true }),
		)
		expect(res.status).toBe(409)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		const meta = row.metadata as Record<string, unknown> | null
		expect(meta?.verified_by).toBeUndefined()
	})

	it('rejects verification from an agent workspace admin', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Agent Alice', email: null })
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: agent.id,
			role: 'admin',
		})

		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			metadata: { provenance: 'writer' },
		})

		const res = await appAs(agent.id).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/verification`, { verified: true }),
		)
		expect(res.status).toBe(403)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		const meta = row.metadata as Record<string, unknown> | null
		expect(meta?.verified_by).toBeUndefined()
	})

	it('rejects verification from a human member without an admin/owner role', async () => {
		const bystander = await insertActor(db, {
			type: 'human',
			name: 'Plain Member',
			email: 'plain@test.com',
		})
		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: bystander.id,
			role: 'member',
		})

		const knowledge = await insertObject(db, workspaceId, ownerId, {
			type: 'knowledge',
			metadata: { provenance: 'writer' },
		})

		const res = await appAs(bystander.id).request(
			jsonRequest('POST', `/api/objects/${knowledge.id}/verification`, { verified: true }),
		)
		expect(res.status).toBe(403)

		const [row] = await db.select().from(objects).where(eq(objects.id, knowledge.id))
		const meta = row.metadata as Record<string, unknown> | null
		expect(meta?.verified_by).toBeUndefined()
	})
})
