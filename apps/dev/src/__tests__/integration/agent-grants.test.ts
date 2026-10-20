import { OpenAPIHono } from '@hono/zod-openapi'
import { events, agentGrants, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiError } from '../../lib/errors'
import {
	effectiveAccess,
	listAgentAccess,
	resolveAgentAccess,
} from '../../lib/integrations/agent-access'
import integrationsGrantsRoutes from '../../routes/integrations-grants'
import { insertActor, insertAgentGrant, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
	app.route('/api/integrations', integrationsGrantsRoutes)
	return app
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agentA = await insertActor(db, { type: 'agent' })
	const agentB = await insertActor(db, { type: 'agent' })
	for (const a of [agentA, agentB]) {
		await db.insert(workspaceMembers).values({ workspaceId: ws.id, actorId: a.id, role: 'member' })
	}
	return { human, ws, agentA, agentB }
}

async function insertIntegration(
	s: Awaited<ReturnType<typeof setup>>,
	over: Partial<typeof integrations.$inferInsert> = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId: s.ws.id,
			provider: 'slack',
			status: 'active',
			credentials: 'x',
			createdBy: s.human,
			...over,
		})
		.returning()
	return row
}

function req(
	app: ReturnType<typeof appFor>,
	method: string,
	path: string,
	workspaceId: string,
	body?: unknown,
) {
	return app.request(`/api/integrations${path}`, {
		method,
		headers: { 'X-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

describe('effectiveAccess (pure)', () => {
	it('uses the default for an ordinary integration with no grant', () => {
		expect(effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read' }, null)).toBe(
			'read',
		)
		expect(effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'none' }, null)).toBe(
			'none',
		)
	})
	it('lets an explicit grant override the default in both directions', () => {
		expect(
			effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read' }, 'read_write'),
		).toBe('read_write')
		expect(
			effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read' }, 'none'),
		).toBe('none')
	})
	it('treats a Keychain credential as explicit-grant on/off, ignoring the default', () => {
		expect(effectiveAccess({ providerMode: 'byo_apikey', defaultAgentAccess: 'read' }, null)).toBe(
			'none',
		)
		expect(effectiveAccess({ providerMode: 'byo_login', defaultAgentAccess: 'read' }, 'read')).toBe(
			'read_write',
		)
	})
})

describe('resolveAgentAccess / listAgentAccess (Integration)', () => {
	it('gives agents default read, an override its own level, and humans full access', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: slack.id,
			actorId: s.agentA.id,
			access: 'read_write',
		})
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentA.id)).toBe('read_write')
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentB.id)).toBe('read')
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.human)).toBe('read_write')
		expect(await resolveAgentAccess(db, s.ws.id, crypto.randomUUID(), s.agentA.id)).toBeNull()

		const listed = await listAgentAccess(db, s.ws.id, s.agentB.id)
		expect(listed.map((r) => [r.provider, r.access])).toEqual([['slack', 'read']])
	})

	it('never resolves across workspaces', async () => {
		const s = await setup()
		const other = await insertWorkspace(db, s.human)
		const slack = await insertIntegration(s)
		expect(await resolveAgentAccess(db, other.id, slack.id, s.agentA.id)).toBeNull()
	})

	it('fails closed for a Keychain credential with no grant', async () => {
		const s = await setup()
		const key = await insertIntegration(s, {
			provider: 'custom',
			providerMode: 'byo_apikey',
			displayName: 'K',
			defaultAgentAccess: 'none',
		})
		expect(await resolveAgentAccess(db, s.ws.id, key.id, s.agentA.id)).toBe('none')
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: key.id,
			actorId: s.agentA.id,
		})
		expect(await resolveAgentAccess(db, s.ws.id, key.id, s.agentA.id)).toBe('read_write')
	})
})

describe('agent_grants table semantics (Integration)', () => {
	it('is unique per (integration, agent)', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		await db.insert(agentGrants).values({
			workspaceId: s.ws.id,
			integrationId: slack.id,
			actorId: s.agentA.id,
			access: 'read',
		})
		await expect(
			db.insert(agentGrants).values({
				workspaceId: s.ws.id,
				integrationId: slack.id,
				actorId: s.agentA.id,
				access: 'read',
			}),
		).rejects.toThrow()
	})

	it('rejects an access value outside none/read/read_write, including the retired write', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const err = await db
			.insert(agentGrants)
			.values({
				workspaceId: s.ws.id,
				integrationId: slack.id,
				actorId: s.agentA.id,
				access: 'admin' as never,
			})
			.then(
				() => null,
				(e: { cause?: { constraint_name?: string } }) => e,
			)
		expect(err?.cause?.constraint_name).toBe('agent_grants_access_enum')
	})

	it('cascades when the integration or the agent is deleted', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: slack.id,
			actorId: s.agentA.id,
		})
		await db.delete(integrations).where(eq(integrations.id, slack.id))
		expect(
			await db.select().from(agentGrants).where(eq(agentGrants.integrationId, slack.id)),
		).toEqual([])
	})
})

describe('grants routes (Integration)', () => {
	it('GET lists the default and explicit grants', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: slack.id,
			actorId: s.agentA.id,
			access: 'read_write',
		})
		const res = await req(appFor(s.human), 'GET', `/${slack.id}/grants`, s.ws.id)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			integrationId: slack.id,
			mode: 'standard',
			defaultAgentAccess: 'read',
			grants: [{ actorId: s.agentA.id, access: 'read_write' }],
		})
	})

	it('PUT sets, changes and DELETE removes a grant, with an event each time', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const app = appFor(s.human)
		const url = `/${slack.id}/grants/${s.agentA.id}`

		expect((await req(app, 'PUT', url, s.ws.id, { access: 'read_write' })).status).toBe(200)
		expect((await req(app, 'PUT', url, s.ws.id, { access: 'read' })).status).toBe(200)
		const [row] = await db.select().from(agentGrants).where(eq(agentGrants.integrationId, slack.id))
		expect(row.access).toBe('read')

		expect((await req(app, 'DELETE', url, s.ws.id)).status).toBe(200)
		expect(
			await db.select().from(agentGrants).where(eq(agentGrants.integrationId, slack.id)),
		).toEqual([])

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, slack.id), eq(events.workspaceId, s.ws.id)))
		expect(evs.map((e) => (e.data as { change?: string }).change)).toEqual([
			'agent_grant',
			'agent_grant',
			'agent_grant',
		])
	})

	it('refuses a grant for a person, a stranger, or a caller that is an agent', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const stranger = await insertActor(db, { type: 'agent' })
		expect(
			(
				await req(appFor(s.human), 'PUT', `/${slack.id}/grants/${s.human}`, s.ws.id, {
					access: 'read',
				})
			).status,
		).toBe(400)
		expect(
			(
				await req(appFor(s.human), 'PUT', `/${slack.id}/grants/${stranger.id}`, s.ws.id, {
					access: 'read',
				})
			).status,
		).toBe(400)
		expect(
			(
				await req(
					appFor(s.agentA.id, 'agent'),
					'PUT',
					`/${slack.id}/grants/${s.agentB.id}`,
					s.ws.id,
					{
						access: 'read_write',
					},
				)
			).status,
		).toBe(403)
	})

	it('only allows read_write on a Keychain credential, and no default', async () => {
		const s = await setup()
		const key = await insertIntegration(s, {
			provider: 'custom',
			providerMode: 'byo_apikey',
			displayName: 'K',
			defaultAgentAccess: 'none',
		})
		const app = appFor(s.human)
		expect(
			(await req(app, 'PUT', `/${key.id}/grants/${s.agentA.id}`, s.ws.id, { access: 'read' }))
				.status,
		).toBe(400)
		expect(
			(await req(app, 'PUT', `/${key.id}/grants/${s.agentA.id}`, s.ws.id, { access: 'read_write' }))
				.status,
		).toBe(200)
		expect(
			(await req(app, 'PUT', `/${key.id}/default-access`, s.ws.id, { defaultAgentAccess: 'read' }))
				.status,
		).toBe(400)
	})

	it('lets a person switch the default to none, and back', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const app = appFor(s.human)
		expect(
			(
				await req(app, 'PUT', `/${slack.id}/default-access`, s.ws.id, {
					defaultAgentAccess: 'none',
				})
			).status,
		).toBe(200)
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentB.id)).toBe('none')
		expect(
			(
				await req(app, 'PUT', `/${slack.id}/default-access`, s.ws.id, {
					defaultAgentAccess: 'read',
				})
			).status,
		).toBe(200)
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentB.id)).toBe('read')
	})

	it('lets one agent be set to No access while everyone else keeps the read default', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const app = appFor(s.human)
		expect(
			(await req(app, 'PUT', `/${slack.id}/grants/${s.agentA.id}`, s.ws.id, { access: 'none' }))
				.status,
		).toBe(200)
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentA.id)).toBe('none')
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentB.id)).toBe('read')
		const listed = await listAgentAccess(db, s.ws.id, s.agentA.id)
		expect(listed.map((r) => [r.access, r.source])).toEqual([['none', 'grant']])
		// Removing the entry puts the agent back on the default.
		await req(app, 'DELETE', `/${slack.id}/grants/${s.agentA.id}`, s.ws.id)
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentA.id)).toBe('read')
	})

	it('rejects the retired write-only level', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const res = await req(appFor(s.human), 'PUT', `/${slack.id}/grants/${s.agentA.id}`, s.ws.id, {
			access: 'write',
		})
		expect(res.status).toBe(400)
	})

	it('404s for an integration in another workspace', async () => {
		const s = await setup()
		const other = await insertWorkspace(db, s.human)
		const slack = await insertIntegration(s)
		expect((await req(appFor(s.human), 'GET', `/${slack.id}/grants`, other.id)).status).toBe(404)
	})
})
