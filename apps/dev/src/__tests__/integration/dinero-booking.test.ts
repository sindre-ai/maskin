import { OpenAPIHono } from '@hono/zod-openapi'
import { events, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import { fixedAllowedTools } from '../../lib/integrations/providers/dinero/allowed-tools'
import dineroBookingRoutes from '../../routes/dinero-booking'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY ??= 'a'.repeat(64)
})

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
	app.route('/api/dinero-booking', dineroBookingRoutes)
	return app
}

async function setup(connected = true) {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const [dinero] = connected
		? await db
				.insert(integrations)
				.values({
					workspaceId: ws.id,
					provider: 'dinero',
					status: 'active',
					credentials: encrypt(JSON.stringify({ accessToken: 'tok' })),
					createdBy: human,
				})
				.returning()
		: []
	return { human, ws, agent, dinero }
}

const send = (app: ReturnType<typeof appFor>, ws: string, method: string, body?: unknown) =>
	app.request('/api/dinero-booking', {
		method,
		headers: { 'x-workspace-id': ws, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})

const configOf = async (id: string) =>
	(await db.select().from(integrations).where(eq(integrations.id, id)))[0]?.config as Record<
		string,
		unknown
	> | null

describe('The Dinero booking switch (Integration)', () => {
	it('starts off and says what switching it on means', async () => {
		const s = await setup()
		const res = await send(appFor(s.human), s.ws.id, 'GET')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { enabled: boolean; statement: string }
		expect(body.enabled).toBe(false)
		expect(body.statement).toMatch(/super-user/)
		expect(body.statement).toMatch(/counter-posting/)
	})

	it('switches on for a person who confirms they read it, and off again', async () => {
		const s = await setup()
		const app = appFor(s.human)
		const on = await send(app, s.ws.id, 'PUT', { enabled: true, acknowledged: true })
		expect(on.status).toBe(200)
		expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true)
		expect(fixedAllowedTools('dinero', await configOf(s.dinero.id))).toContain('BookVoucher')

		const off = await send(app, s.ws.id, 'PUT', { enabled: false })
		expect(off.status).toBe(200)
		expect(fixedAllowedTools('dinero', await configOf(s.dinero.id))).not.toContain('BookVoucher')

		const logged = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.dinero.id), eq(events.action, 'dinero_booking_switched')))
		expect(logged).toHaveLength(2)
	})

	it('does not switch on without the confirmation', async () => {
		const s = await setup()
		const res = await send(appFor(s.human), s.ws.id, 'PUT', { enabled: true })
		expect(res.status).toBe(400)
		expect((await configOf(s.dinero.id))?.dinero_booking).toBeUndefined()
	})

	it('is refused for an agent, whatever its access', async () => {
		const s = await setup()
		const res = await send(appFor(s.agent.id, 'agent'), s.ws.id, 'PUT', {
			enabled: true,
			acknowledged: true,
		})
		expect(res.status).toBe(403)
		expect((await configOf(s.dinero.id))?.dinero_booking).toBeUndefined()
	})

	it('answers not found when Dinero is not connected', async () => {
		const s = await setup(false)
		const res = await send(appFor(s.human), s.ws.id, 'PUT', { enabled: true, acknowledged: true })
		expect(res.status).toBe(404)
	})
})
