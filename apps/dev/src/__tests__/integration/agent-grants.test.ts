import { OpenAPIHono } from '@hono/zod-openapi'
import { events, agentGrants, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiError } from '../../lib/errors'
import {
	canRead,
	canWrite,
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
	it('uses a read_write default for an agent with no grant', () => {
		expect(
			effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read_write' }, null),
		).toBe('read_write')
		expect(
			effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read_write' }, 'none'),
		).toBe('none')
	})
	it('lets an explicit grant override the default in both directions', () => {
		expect(
			effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read' }, 'read_write'),
		).toBe('read_write')
		expect(
			effectiveAccess({ providerMode: 'registered', defaultAgentAccess: 'read' }, 'none'),
		).toBe('none')
	})
	it('treats a Keychain credential as on/off: its own entry, else the default', () => {
		const key = (defaultAgentAccess: 'read' | 'none') => ({
			providerMode: 'byo_apikey' as const,
			defaultAgentAccess,
		})
		// Fail-closed until a person says otherwise.
		expect(effectiveAccess(key('none'), null)).toBe('none')
		expect(effectiveAccess(key('read'), null)).toBe('read_write')
		// An entry of its own wins in both directions, and any non-none level is just "on".
		expect(effectiveAccess(key('read'), 'none')).toBe('none')
		expect(effectiveAccess(key('none'), 'read_write')).toBe('read_write')
		expect(effectiveAccess({ ...key('none'), providerMode: 'byo_login' }, 'read')).toBe(
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

	it('rejects an access value outside none/read/read_write, including the retired write and ask_first', async () => {
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

	it('only allows read_write or none on a Keychain credential, and lets its default be set', async () => {
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
			(await req(app, 'PUT', `/${key.id}/grants/${s.agentA.id}`, s.ws.id, { access: 'none' }))
				.status,
		).toBe(200)
		expect(
			(await req(app, 'PUT', `/${key.id}/default-access`, s.ws.id, { defaultAgentAccess: 'read' }))
				.status,
		).toBe(200)
	})

	it('rejects Read & write as the default for a Keychain credential and leaves the stored default alone', async () => {
		const s = await setup()
		const key = await insertIntegration(s, {
			provider: 'custom',
			providerMode: 'byo_apikey',
			displayName: 'K',
			defaultAgentAccess: 'none',
		})
		const app = appFor(s.human)
		const stored = async () =>
			(await db.select().from(integrations).where(eq(integrations.id, key.id)))[0]
				?.defaultAgentAccess

		const res = await req(app, 'PUT', `/${key.id}/default-access`, s.ws.id, {
			defaultAgentAccess: 'read_write',
		})

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('use read or none')
		expect(await stored()).toBe('none')
		expect(await resolveAgentAccess(db, s.ws.id, key.id, s.agentB.id)).toBe('none')
		// On and off still save.
		expect(
			(await req(app, 'PUT', `/${key.id}/default-access`, s.ws.id, { defaultAgentAccess: 'read' }))
				.status,
		).toBe(200)
		expect(await stored()).toBe('read')
		expect(
			(await req(app, 'PUT', `/${key.id}/default-access`, s.ws.id, { defaultAgentAccess: 'none' }))
				.status,
		).toBe(200)
		expect(await stored()).toBe('none')
		// The same level stays allowed as the default for an ordinary integration.
		const slack = await insertIntegration(s)
		expect(
			(
				await req(app, 'PUT', `/${slack.id}/default-access`, s.ws.id, {
					defaultAgentAccess: 'read_write',
				})
			).status,
		).toBe(200)
	})

	it('gives every agent a Keychain credential whose default is Full access, except one set to No access', async () => {
		const s = await setup()
		const key = await insertIntegration(s, {
			provider: 'custom',
			providerMode: 'byo_apikey',
			displayName: 'K',
			defaultAgentAccess: 'none',
		})
		expect(await resolveAgentAccess(db, s.ws.id, key.id, s.agentB.id)).toBe('none')

		const app = appFor(s.human)
		await req(app, 'PUT', `/${key.id}/default-access`, s.ws.id, { defaultAgentAccess: 'read' })
		await req(app, 'PUT', `/${key.id}/grants/${s.agentA.id}`, s.ws.id, { access: 'none' })

		expect(await resolveAgentAccess(db, s.ws.id, key.id, s.agentB.id)).toBe('read_write')
		expect(await resolveAgentAccess(db, s.ws.id, key.id, s.agentA.id)).toBe('none')
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

	it('lets a person make Read & write the default for every agent, and one agent stay read-only', async () => {
		const s = await setup()
		const slack = await insertIntegration(s)
		const app = appFor(s.human)

		const res = await req(app, 'PUT', `/${slack.id}/default-access`, s.ws.id, {
			defaultAgentAccess: 'read_write',
		})

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ defaultAgentAccess: 'read_write' })
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentA.id)).toBe('read_write')
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentB.id)).toBe('read_write')
		await req(app, 'PUT', `/${slack.id}/grants/${s.agentA.id}`, s.ws.id, { access: 'read' })
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentA.id)).toBe('read')
		expect(await resolveAgentAccess(db, s.ws.id, slack.id, s.agentB.id)).toBe('read_write')
		const [row] = await db.select().from(integrations).where(eq(integrations.id, slack.id))
		expect(row.defaultAgentAccess).toBe('read_write')
		const [event] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, slack.id), eq(events.action, 'updated')))
		expect(event.data).toMatchObject({ change: 'default_agent_access', access_after: 'read_write' })
	})

	it('allows Read & write as the default for Gmail too', async () => {
		const s = await setup()
		const gmail = await insertIntegration(s, { provider: 'gmail' })
		const app = appFor(s.human)

		const res = await req(app, 'PUT', `/${gmail.id}/default-access`, s.ws.id, {
			defaultAgentAccess: 'read_write',
		})

		expect(res.status).toBe(200)
		expect(await resolveAgentAccess(db, s.ws.id, gmail.id, s.agentA.id)).toBe('read_write')
	})

	it('rejects a default outside read/read_write/none at the database', async () => {
		const s = await setup()
		await expect(
			insertIntegration(s, { defaultAgentAccess: 'ask_first' as never }),
		).rejects.toThrow()
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

	it('has no "Ask first" level any more, for Gmail or anything else', async () => {
		const s = await setup()
		const gmail = await insertIntegration(s, { provider: 'gmail' })
		const app = appFor(s.human)

		const single = await req(app, 'PUT', `/${gmail.id}/grants/${s.agentA.id}`, s.ws.id, {
			access: 'ask_first',
		})
		const many = await req(app, 'PUT', `/${gmail.id}/grants`, s.ws.id, {
			grants: [{ actorId: s.agentA.id, access: 'ask_first' }],
		})
		const asDefault = await req(app, 'PUT', `/${gmail.id}/default-access`, s.ws.id, {
			defaultAgentAccess: 'ask_first',
		})

		expect([single.status, many.status, asDefault.status]).toEqual([400, 400, 400])
		expect(
			await db.select().from(agentGrants).where(eq(agentGrants.integrationId, gmail.id)),
		).toEqual([])
	})

	it('treats Read & write on Gmail as an agent that may use the write tools', async () => {
		const s = await setup()
		const gmail = await insertIntegration(s, { provider: 'gmail' })
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: gmail.id,
			actorId: s.agentA.id,
			access: 'read_write',
		})

		const access = await resolveAgentAccess(db, s.ws.id, gmail.id, s.agentA.id)

		expect(access).toBe('read_write')
		expect(canRead(access as 'read_write')).toBe(true)
		expect(canWrite(access as 'read_write')).toBe(true)
	})

	it('404s for an integration in another workspace', async () => {
		const s = await setup()
		const other = await insertWorkspace(db, s.human)
		const slack = await insertIntegration(s)
		expect((await req(appFor(s.human), 'GET', `/${slack.id}/grants`, other.id)).status).toBe(404)
	})
})
