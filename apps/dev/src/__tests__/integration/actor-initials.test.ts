import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

const ws = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

async function addMember(workspaceId: string, name: string, type: 'agent' | 'human' = 'agent') {
	const actor = await insertActor(db, { type, name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
	return actor
}

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

// The route as another caller: the shared harness always acts as the test owner.
function createAppAs(actorId: string, actorType: 'human' | 'agent') {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.route('/api/actors', actorsRoutes)
	return app
}

async function storedMetadata(actorId: string) {
	const [row] = await db
		.select({ metadata: actors.metadata })
		.from(actors)
		.where(eq(actors.id, actorId))
	return row.metadata
}

describe('Initials on agents', () => {
	it('sets initials saved upper case, reads them on the detail and the list, and keeps other metadata', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Developer')
		await db
			.update(actors)
			.set({ metadata: { voice_enabled: true, tags: ['Eng'] } })
			.where(eq(actors.id, agent.id))

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: ' dev ' }, ws(workspace.id)),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { initials: string; tags: string[] }
		expect(body.initials).toBe('DEV')
		expect(body.tags).toEqual(['Eng'])
		expect(await storedMetadata(agent.id)).toEqual({
			voice_enabled: true,
			tags: ['Eng'],
			initials: 'DEV',
		})

		const get = await app.request(jsonGet(`/api/actors/${agent.id}`, ws(workspace.id)))
		expect(((await get.json()) as { initials: string }).initials).toBe('DEV')
		const list = await app.request(jsonGet('/api/actors', ws(workspace.id)))
		const rows = (await list.json()) as Array<{ id: string; initials: string | null }>
		expect(rows.find((r) => r.id === agent.id)?.initials).toBe('DEV')
	})

	it('an agent with none set reads null', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Plain')
		const get = await app.request(jsonGet(`/api/actors/${agent.id}`, ws(workspace.id)))
		expect(((await get.json()) as { initials: string | null }).initials).toBeNull()
	})

	it('an empty string or null removes the key, so the automatic letters come back', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Clearable')
		for (const cleared of ['', '  ', null]) {
			await app.request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: 'AB' }, ws(workspace.id)),
			)
			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: cleared }, ws(workspace.id)),
			)
			expect(res.status).toBe(200)
			expect(((await res.json()) as { initials: string | null }).initials).toBeNull()
			expect(await storedMetadata(agent.id)).not.toHaveProperty('initials')
		}
	})

	it('refuses four letters, spaces and symbols, and a human target, writing nothing', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Strict')
		const human = await addMember(workspace.id, 'Person', 'human')

		for (const bad of ['ABCD', 'A B', 'A-B', '<b>']) {
			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: bad }, ws(workspace.id)),
			)
			expect(res.status).toBe(400)
		}
		const humanRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${human.id}`, { initials: 'PE' }, ws(workspace.id)),
		)
		expect(humanRes.status).toBe(400)
		expect(await storedMetadata(agent.id)).not.toHaveProperty('initials')
		expect(await storedMetadata(human.id)).not.toHaveProperty('initials')
	})

	it('one save with initials, tags and starters keeps all three, and clearing initials keeps the rest', async () => {
		const app = createApp()
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Together')
		await app.request(
			jsonRequest(
				'PATCH',
				`/api/actors/${agent.id}`,
				{ initials: 'TG', tags: ['Ops'], starter_prompts: ['Keep me'] },
				ws(workspace.id),
			),
		)
		expect(await storedMetadata(agent.id)).toEqual({
			initials: 'TG',
			tags: ['Ops'],
			starter_prompts: ['Keep me'],
		})
		await app.request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: null }, ws(workspace.id)),
		)
		expect(await storedMetadata(agent.id)).toEqual({ tags: ['Ops'], starter_prompts: ['Keep me'] })
	})

	it('refuses a viewer and a plain member, lets the agent set its own, and lets an admin set any', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(workspace.id, 'Guarded')
		const viewer = await insertActor(db, { type: 'human', name: 'Viewer' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: workspace.id, actorId: viewer.id, role: 'viewer' })
		const member = await addMember(workspace.id, 'Member', 'human')
		const otherAgent = await addMember(workspace.id, 'Other agent')

		for (const [callerId, callerType] of [
			[viewer.id, 'human'],
			[member.id, 'human'],
			[otherAgent.id, 'agent'],
		] as const) {
			const res = await createAppAs(callerId, callerType).request(
				jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: 'XX' }, ws(workspace.id)),
			)
			expect(res.status).toBe(403)
		}
		expect(await storedMetadata(agent.id)).not.toHaveProperty('initials')

		const own = await createAppAs(agent.id, 'agent').request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: 'GD' }, ws(workspace.id)),
		)
		expect(own.status).toBe(200)

		// The shared harness acts as the workspace owner.
		const admin = await createApp().request(
			jsonRequest('PATCH', `/api/actors/${agent.id}`, { initials: 'ADM' }, ws(workspace.id)),
		)
		expect(admin.status).toBe(200)
		expect(((await admin.json()) as { initials: string }).initials).toBe('ADM')
	})
})
