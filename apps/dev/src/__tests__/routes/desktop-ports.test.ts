import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import desktopRoutes from '../../routes/desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const AGENT = '44444444-4444-4444-8444-444444444444'
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555'
const SESSION = '66666666-6666-4666-8666-666666666666'
const SERVER_A = 'server-a'
const SERVER_B = 'server-b'

type SessionRow = {
	id: string
	actorId: string
	workspaceId: string
	status: string
	agentServerId: string | null
}

const liveSession = (over: Partial<SessionRow> = {}): SessionRow => ({
	id: SESSION,
	actorId: AGENT,
	workspaceId: WS,
	status: 'running',
	agentServerId: SERVER_A,
	...over,
})

// The access rule joins to find the agent; the session lookup does not.
function build(opts: {
	session?: SessionRow | null
	service: Record<string, unknown>
	actorType?: string
	actorId?: string
}) {
	const inserts: unknown[] = []
	const db = {
		insert: () => ({
			values: async (row: unknown) => {
				inserts.push(row)
			},
		}),
		select: () => {
			let joined = false
			const q = {
				from: () => q,
				innerJoin: () => {
					joined = true
					return q
				},
				where: () => q,
				limit: async () => (joined ? [{ id: AGENT }] : opts.session ? [opts.session] : []),
			}
			return q
		},
	}
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', opts.actorId ?? AGENT)
		c.set('actorType', opts.actorType ?? 'agent')
		c.set('desktopService', opts.service)
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return { app, inserts }
}

const expose = (app: ReturnType<typeof build>['app'], body: unknown, query = '') =>
	app.request(`/api/desktop/ports${query}`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

const located = (serverId = SERVER_A) => ({
	server: { id: serverId, url: 'http://box', secret: 's', status: 'active' },
	password: 'pw',
})

describe('POST /api/desktop/ports', () => {
	beforeEach(() => {})

	it('opens the port on the server that hosts both the computer and the session', async () => {
		const ensure = vi.fn(async () => located())
		const ports = vi.fn(async () => ({
			status: 200,
			body: { guest_port: 5173, relay_port: 20003, url: 'http://host.microsandbox.internal:20003' },
		}))
		const { app, inserts } = build({ session: liveSession(), service: { ensure, ports } })

		const res = await expose(app, { session_id: SESSION, guest_port: 5173 })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ url: 'http://host.microsandbox.internal:20003' })
		expect(res.headers.get('cache-control')).toBe('no-store')
		// a new computer is created next to the session, not on whichever box is first
		expect(ensure).toHaveBeenCalledWith(WS, AGENT, { preferServerId: SERVER_A })
		expect(ports).toHaveBeenCalledWith(expect.objectContaining({ id: SERVER_A }), WS, AGENT, {
			type: 'expose',
			sessionId: SESSION,
			guestPort: 5173,
		})
		expect(inserts).toEqual([
			expect.objectContaining({
				action: 'updated',
				entityType: 'workspace_desktop',
				data: { agent_id: AGENT, control: 'expose_port', guest_port: 5173 },
			}),
		])
	})

	it('never takes a host port from the caller', async () => {
		const ports = vi.fn(async () => ({ status: 200, body: {} }))
		const { app } = build({
			session: liveSession(),
			service: { ensure: vi.fn(async () => located()), ports },
		})

		await expose(app, { session_id: SESSION, guest_port: 5173, relay_port: 22 })

		expect(JSON.stringify(ports.mock.calls)).not.toContain('22')
	})

	it('refuses a session that is not the agent’s own, saying only that it was not found', async () => {
		const ports = vi.fn()
		const { app } = build({
			session: liveSession({ actorId: OTHER_AGENT }),
			service: { ensure: vi.fn(async () => located()), ports },
		})

		const res = await expose(app, { session_id: SESSION, guest_port: 5173 })

		expect(res.status).toBe(404)
		expect(ports).not.toHaveBeenCalled()
	})

	it('refuses a session in another workspace', async () => {
		const ports = vi.fn()
		const { app } = build({
			session: liveSession({ workspaceId: '99999999-9999-4999-8999-999999999999' }),
			service: { ensure: vi.fn(async () => located()), ports },
		})

		expect((await expose(app, { session_id: SESSION, guest_port: 5173 })).status).toBe(404)
		expect(ports).not.toHaveBeenCalled()
	})

	it('refuses a session that is not running any more', async () => {
		const ports = vi.fn()
		const { app } = build({
			session: liveSession({ status: 'completed' }),
			service: { ensure: vi.fn(async () => located()), ports },
		})

		const res = await expose(app, { session_id: SESSION, guest_port: 5173 })

		expect(res.status).toBe(409)
		expect(ports).not.toHaveBeenCalled()
	})

	it('refuses a session that does not run on an agent-server', async () => {
		const ensure = vi.fn()
		const { app } = build({
			session: liveSession({ agentServerId: null }),
			service: { ensure, ports: vi.fn() },
		})

		expect((await expose(app, { session_id: SESSION, guest_port: 5173 })).status).toBe(409)
		expect(ensure).not.toHaveBeenCalled()
	})

	it('explains when the computer lives on a different server than the session', async () => {
		const ports = vi.fn()
		const { app } = build({
			session: liveSession(),
			service: { ensure: vi.fn(async () => located(SERVER_B)), ports },
		})

		const res = await expose(app, { session_id: SESSION, guest_port: 5173 })
		const body = (await res.json()) as { error: { message: string } }

		expect(res.status).toBe(409)
		expect(body.error.message).toMatch(/different server/)
		expect(ports).not.toHaveBeenCalled()
	})

	it('passes the agent-server’s refusal through, without recording an event', async () => {
		const { app, inserts } = build({
			session: liveSession(),
			service: {
				ensure: vi.fn(async () => located()),
				ports: vi.fn(async () => ({
					status: 409,
					body: { error: 'too_many_ports', message: 'Close one first.' },
				})),
			},
		})

		const res = await expose(app, { session_id: SESSION, guest_port: 5173 })

		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ error: 'too_many_ports' })
		expect(inserts).toHaveLength(0)
	})

	it('rejects an out-of-range port and a malformed session id', async () => {
		const { app } = build({ session: liveSession(), service: { ensure: vi.fn(), ports: vi.fn() } })

		expect((await expose(app, { session_id: SESSION, guest_port: 70000 })).status).toBe(400)
		expect((await expose(app, { session_id: SESSION, guest_port: 0 })).status).toBe(400)
		expect((await expose(app, { session_id: 'nope', guest_port: 5173 })).status).toBe(400)
	})

	it('refuses an agent that names a colleague’s computer', async () => {
		const ensure = vi.fn()
		const { app } = build({ session: liveSession(), service: { ensure, ports: vi.fn() } })

		const res = await expose(
			app,
			{ session_id: SESSION, guest_port: 5173 },
			`?agent_id=${OTHER_AGENT}`,
		)

		expect(res.status).toBe(403)
		expect(ensure).not.toHaveBeenCalled()
	})
})

describe('GET and DELETE /api/desktop/ports', () => {
	beforeEach(() => {})

	it('lists without starting a computer: none yet means no ports', async () => {
		const ensure = vi.fn()
		const { app } = build({ service: { locate: vi.fn(async () => null), ensure, ports: vi.fn() } })

		const res = await app.request('/api/desktop/ports', { headers: { 'X-Workspace-Id': WS } })

		expect(await res.json()).toEqual({ ports: [] })
		expect(ensure).not.toHaveBeenCalled()
	})

	it('lists what the hosting server reports', async () => {
		const ports = vi.fn(async () => ({ status: 200, body: { ports: [{ relay_port: 20003 }] } }))
		const { app } = build({ service: { locate: vi.fn(async () => located()), ports } })

		const res = await app.request('/api/desktop/ports', { headers: { 'X-Workspace-Id': WS } })

		expect(await res.json()).toEqual({ ports: [{ relay_port: 20003 }] })
		expect(ports).toHaveBeenCalledWith(expect.anything(), WS, AGENT, { type: 'list' })
	})

	it('closes a port by its relay port', async () => {
		const ports = vi.fn(async () => ({ status: 200, body: { closed: true } }))
		const { app } = build({ service: { locate: vi.fn(async () => located()), ports } })

		const res = await app.request('/api/desktop/ports/20003', {
			method: 'DELETE',
			headers: { 'X-Workspace-Id': WS },
		})

		expect(await res.json()).toEqual({ closed: true })
		expect(ports).toHaveBeenCalledWith(expect.anything(), WS, AGENT, {
			type: 'close',
			relayPort: 20003,
		})
	})

	it('rejects a relay port that is not a port number', async () => {
		const { app } = build({ service: { locate: vi.fn(), ports: vi.fn() } })

		const res = await app.request('/api/desktop/ports/abc', {
			method: 'DELETE',
			headers: { 'X-Workspace-Id': WS },
		})

		expect(res.status).toBe(400)
	})
})
