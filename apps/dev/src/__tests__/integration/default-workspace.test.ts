import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: workspacesRoutes } = await import('../../routes/workspaces')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: SessionManager }
}

/** Actors + workspaces routes, authenticated as the given human. */
function createAppAs(actorId: string) {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/actors', actorsRoutes as unknown as OpenAPIHono<Env>)
	app.route('/api/workspaces', workspacesRoutes as unknown as OpenAPIHono<Env>)
	return app
}

async function defaultFlags(app: ReturnType<typeof createAppAs>) {
	const res = await app.request(jsonGet('/api/workspaces'))
	const rows = (await res.json()) as Array<{ id: string; isDefault: boolean }>
	return Object.fromEntries(rows.map((w) => [w.id, w.isDefault]))
}

describe('default workspace', () => {
	it('marks no workspace as default until the actor picks one', async () => {
		const me = await insertActor(db)
		const wsA = await insertWorkspace(db, me.id)
		const app = createAppAs(me.id)

		expect(await defaultFlags(app)).toEqual({ [wsA.id]: false })
	})

	it('marks exactly the chosen workspace and moves the flag when another is chosen', async () => {
		const me = await insertActor(db)
		const wsA = await insertWorkspace(db, me.id)
		const wsB = await insertWorkspace(db, me.id)
		const app = createAppAs(me.id)

		const first = await app.request(
			jsonRequest('PATCH', `/api/actors/${me.id}`, { default_workspace_id: wsA.id }),
		)
		expect(first.status).toBe(200)
		expect((await first.json()).default_workspace_id).toBe(wsA.id)
		expect(await defaultFlags(app)).toEqual({ [wsA.id]: true, [wsB.id]: false })

		await app.request(
			jsonRequest('PATCH', `/api/actors/${me.id}`, { default_workspace_id: wsB.id }),
		)
		expect(await defaultFlags(app)).toEqual({ [wsA.id]: false, [wsB.id]: true })
	})

	it('clears the default when null is sent', async () => {
		const me = await insertActor(db)
		const ws = await insertWorkspace(db, me.id)
		const app = createAppAs(me.id)
		await app.request(jsonRequest('PATCH', `/api/actors/${me.id}`, { default_workspace_id: ws.id }))

		const cleared = await app.request(
			jsonRequest('PATCH', `/api/actors/${me.id}`, { default_workspace_id: null }),
		)

		expect(cleared.status).toBe(200)
		expect(await defaultFlags(app)).toEqual({ [ws.id]: false })
	})

	it('rejects a workspace the actor is not a member of', async () => {
		const me = await insertActor(db)
		const stranger = await insertActor(db)
		const foreign = await insertWorkspace(db, stranger.id)
		const app = createAppAs(me.id)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${me.id}`, { default_workspace_id: foreign.id }),
		)

		expect(res.status).toBe(400)
		const [row] = await db
			.select({ id: actors.defaultWorkspaceId })
			.from(actors)
			.where(eq(actors.id, me.id))
		expect(row.id).toBeNull()
	})

	it("refuses to set another actor's default workspace", async () => {
		const me = await insertActor(db)
		const other = await insertActor(db)
		const ws = await insertWorkspace(db, me.id)
		const app = createAppAs(me.id)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${other.id}`, { default_workspace_id: ws.id }),
		)

		expect(res.status).toBe(403)
	})

	it('ignores a stale default after the actor lost membership', async () => {
		const me = await insertActor(db)
		const other = await insertActor(db)
		const ws = await insertWorkspace(db, other.id)
		// A preference written while the actor was a member, left behind afterwards.
		await db.update(actors).set({ defaultWorkspaceId: ws.id }).where(eq(actors.id, me.id))
		const mine = await insertWorkspace(db, me.id)
		const app = createAppAs(me.id)

		expect(await defaultFlags(app)).toEqual({ [mine.id]: false })
	})

	it('clears the preference when the workspace is deleted (ON DELETE SET NULL)', async () => {
		const me = await insertActor(db)
		const ws = await insertWorkspace(db, me.id)
		await db.update(actors).set({ defaultWorkspaceId: ws.id }).where(eq(actors.id, me.id))

		await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id))
		await db.delete(workspaces).where(eq(workspaces.id, ws.id))

		const [row] = await db
			.select({ id: actors.defaultWorkspaceId })
			.from(actors)
			.where(eq(actors.id, me.id))
		expect(row.id).toBeNull()
	})
})
