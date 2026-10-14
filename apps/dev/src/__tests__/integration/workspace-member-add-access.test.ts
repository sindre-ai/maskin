import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: workspacesRoutes } = await import('../../routes/workspaces')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: { createSession: () => Promise<unknown> }
	}
}

function createAppAs(actorId: string, actorType: 'human' | 'agent') {
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
		c.set('actorType', actorType)
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', { createSession: async () => ({}) })
		await next()
	})
	// Same typed-boundary pattern as workspace-capacity.test.ts: the narrower
	// route Env is assigned once here rather than inside app.route().
	app.route('/api/workspaces', workspacesRoutes as unknown as OpenAPIHono<Env>)
	return app
}

async function memberRows(workspaceId: string) {
	return db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
}

async function seedMember(workspaceId: string, actorId: string, role: string) {
	await db.insert(workspaceMembers).values({ workspaceId, actorId, role })
}

function addMember(
	app: ReturnType<typeof createAppAs>,
	workspaceId: string,
	body: Record<string, unknown>,
) {
	return app.request(jsonRequest('POST', `/api/workspaces/${workspaceId}/members`, body))
}

describe('POST /api/workspaces/:id/members access', () => {
	// Pro plan so the seat cap never interferes with the access outcome.
	async function setup() {
		const owner = await insertActor(db, { type: 'human' })
		const ws = await insertWorkspace(db, owner.id, { settings: { billing: { plan: 'pro' } } })
		const target = await insertActor(db, { type: 'human' })
		return { owner, ws, target }
	}

	it('returns 403 and writes no row when a plain human member calls it', async () => {
		const { ws, target } = await setup()
		const member = await insertActor(db, { type: 'human' })
		await seedMember(ws.id, member.id, 'member')
		const before = await memberRows(ws.id)

		const res = await addMember(createAppAs(member.id, 'human'), ws.id, {
			actor_id: target.id,
			role: 'member',
		})

		expect(res.status).toBe(403)
		expect(await memberRows(ws.id)).toHaveLength(before.length)
	})

	it('returns 403 and writes no row when an agent member calls it', async () => {
		const { ws, target } = await setup()
		const agent = await insertActor(db, { type: 'agent' })
		await seedMember(ws.id, agent.id, 'member')
		const before = await memberRows(ws.id)

		const res = await addMember(createAppAs(agent.id, 'agent'), ws.id, {
			actor_id: target.id,
			role: 'member',
		})

		expect(res.status).toBe(403)
		expect(await memberRows(ws.id)).toHaveLength(before.length)
	})

	it('returns 403 for an agent holding the admin role', async () => {
		const { ws, target } = await setup()
		const agent = await insertActor(db, { type: 'agent' })
		await seedMember(ws.id, agent.id, 'admin')
		const before = await memberRows(ws.id)

		const res = await addMember(createAppAs(agent.id, 'agent'), ws.id, { actor_id: target.id })

		expect(res.status).toBe(403)
		expect(await memberRows(ws.id)).toHaveLength(before.length)
	})

	it('returns 404 and writes no row when the caller is not a member', async () => {
		const { ws, target } = await setup()
		const outsider = await insertActor(db, { type: 'human' })
		const before = await memberRows(ws.id)

		const res = await addMember(createAppAs(outsider.id, 'human'), ws.id, {
			actor_id: target.id,
			role: 'member',
		})

		expect(res.status).toBe(404)
		expect(await memberRows(ws.id)).toHaveLength(before.length)
	})

	it('gives a non-member the same 404 for a real and a nonexistent workspace', async () => {
		const { ws, target } = await setup()
		const outsider = await insertActor(db, { type: 'human' })
		const app = createAppAs(outsider.id, 'human')

		const real = await addMember(app, ws.id, { actor_id: target.id })
		const missing = await addMember(app, randomUUID(), { actor_id: target.id })

		expect(real.status).toBe(404)
		expect(missing.status).toBe(404)
		expect(await real.json()).toEqual(await missing.json())
	})

	it('does not let a key from workspace A add a member to workspace B', async () => {
		const a = await setup()
		const b = await setup()
		const victim = await insertActor(db, { type: 'agent' })
		const before = await memberRows(b.ws.id)

		// a.owner is a human owner of workspace A only.
		const res = await addMember(createAppAs(a.owner.id, 'human'), b.ws.id, {
			actor_id: victim.id,
			role: 'member',
		})

		expect(res.status).toBe(404)
		expect(await memberRows(b.ws.id)).toHaveLength(before.length)
	})

	it.each(['member', 'admin'] as const)(
		'returns 201 and writes the %s row when a human owner calls it',
		async (role) => {
			const { owner, ws, target } = await setup()

			const res = await addMember(createAppAs(owner.id, 'human'), ws.id, {
				actor_id: target.id,
				role,
			})

			expect(res.status).toBe(201)
			const rows = await memberRows(ws.id)
			expect(rows.find((r) => r.actorId === target.id)?.role).toBe(role)
		},
	)

	it('returns 201 when a human admin calls it', async () => {
		const { ws, target } = await setup()
		const admin = await insertActor(db, { type: 'human' })
		await seedMember(ws.id, admin.id, 'admin')

		const res = await addMember(createAppAs(admin.id, 'human'), ws.id, { actor_id: target.id })

		expect(res.status).toBe(201)
	})

	it('returns 400 for role owner, even for a human owner, and writes no row', async () => {
		const { owner, ws, target } = await setup()
		const before = await memberRows(ws.id)

		const res = await addMember(createAppAs(owner.id, 'human'), ws.id, {
			actor_id: target.id,
			role: 'owner',
		})

		expect(res.status).toBe(400)
		expect(await memberRows(ws.id)).toHaveLength(before.length)
	})

	it('returns 400 for a free-text role', async () => {
		const { owner, ws, target } = await setup()

		const res = await addMember(createAppAs(owner.id, 'human'), ws.id, {
			actor_id: target.id,
			role: 'superuser',
		})

		expect(res.status).toBe(400)
	})
})
