import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { consumeDesktopTicket } from '../../lib/desktop-ticket'
import { resolveKeychainTyping } from '../../lib/integrations/keychain-typing'
import desktopRoutes from '../../routes/desktop'

vi.mock('../../lib/integrations/keychain-typing', () => ({
	resolveKeychainTyping: vi.fn(async () => ({ kind: 'plain' })),
}))

const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'test-actor-id'
// The agent whose computer it is, a colleague of it, and an agent actor acting as itself.
const AGENT = '44444444-4444-4444-8444-444444444444'
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555'

// The access rule looks the agent up with select().from().innerJoin().where().limit().
function selectChain(rows: unknown[]) {
	const q = { from: () => q, innerJoin: () => q, where: () => q, limit: async () => rows }
	return q
}

function build(
	service: Record<string, unknown>,
	opts: {
		actorType?: string
		actorId?: string
		agentInWorkspace?: boolean
		workspaceRole?: string
	} = {},
) {
	const inserts: unknown[] = []
	const db = {
		insert: () => ({
			values: async (row: unknown) => {
				inserts.push(row)
			},
		}),
		select: () => selectChain(opts.agentInWorkspace === false ? [] : [{ id: AGENT }]),
	}
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	// app-factory's onError is what turns ViewerReadOnlyError into a 403.
	app.onError((err, c) => {
		const status = (err as { status?: number }).status
		return c.json({ error: String(err) }, (status ?? 500) as 403 | 500)
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', opts.actorId ?? ACTOR)
		c.set('actorType', opts.actorType ?? 'human')
		if (opts.workspaceRole) c.set('workspaceRole', opts.workspaceRole)
		c.set('desktopService', service)
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return { app, inserts }
}

type TestApp = ReturnType<typeof build>['app']

const post = (app: TestApp, headers: Record<string, string> = {}, query = `?agent_id=${AGENT}`) =>
	app.request(`/api/desktop/connect${query}`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, ...headers },
	})

const del = (app: TestApp, query = `?agent_id=${AGENT}`) =>
	app.request(`/api/desktop${query}`, { method: 'DELETE', headers: { 'X-Workspace-Id': WS } })

describe('read-only viewers', () => {
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)
	})

	const writes: Array<[string, string, string, unknown?]> = [
		['connect', 'POST', '/connect'],
		['remove', 'DELETE', ''],
		['screenshot', 'POST', '/screenshot'],
		['input', 'POST', '/input', { action: 'move', x: 10, y: 10 }],
		['exec', 'POST', '/exec', { command: 'id' }],
		['expose port', 'POST', '/ports', { session_id: AGENT, guest_port: 3000 }],
		['close port', 'DELETE', '/ports/20001'],
	]

	it.each(writes)(
		'403s a viewer on %s without touching an agent-server',
		async (_n, method, path, body) => {
			const service = {
				ensure: vi.fn(),
				remove: vi.fn(),
				control: vi.fn(),
				locate: vi.fn(),
				ports: vi.fn(),
			}
			const { app } = build(service, { workspaceRole: 'viewer' })

			const res = await app.request(`/api/desktop${path}?agent_id=${AGENT}`, {
				method,
				headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
				...(body ? { body: JSON.stringify(body) } : {}),
			})

			expect(res.status).toBe(403)
			for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
		},
	)

	it('still lets a viewer list the open ports', async () => {
		const { app } = build({ locate: vi.fn(async () => null) }, { workspaceRole: 'viewer' })
		const res = await app.request(`/api/desktop/ports?agent_id=${AGENT}`, {
			headers: { 'X-Workspace-Id': WS },
		})
		expect(res.status).toBe(200)
	})
})

describe('POST /api/desktop/connect', () => {
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)
	})

	it('returns a ticket bound to the workspace, actor and agent, plus the VNC password', async () => {
		const { app } = build({
			ensure: vi.fn(async () => ({ server: { id: 's' }, password: 'pw' })),
		})

		const res = await post(app)
		const body = (await res.json()) as { ticket: string; path: string; password: string }

		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(body.password).toBe('pw')
		expect(body.path).toBe('/api/desktop/stream')
		expect(consumeDesktopTicket(body.ticket)).toEqual({
			workspaceId: WS,
			actorId: ACTOR,
			agentId: AGENT,
		})
	})

	it('records an audit event only when it created the desktop', async () => {
		const created = build({
			ensure: vi.fn(async () => ({ server: { id: 's' }, password: 'pw', created: true })),
		})
		await post(created.app)
		expect(created.inserts).toHaveLength(1)
		expect(created.inserts[0]).toMatchObject({
			workspaceId: WS,
			action: 'created',
			entityType: 'workspace_desktop',
			entityId: WS,
		})

		const existing = build({
			ensure: vi.fn(async () => ({ server: { id: 's' }, password: 'pw' })),
		})
		await post(existing.app)
		expect(existing.inserts).toHaveLength(0)
	})

	it('503s when no desktop can be started', async () => {
		const { app } = build({ ensure: vi.fn(async () => null) })
		expect((await post(app)).status).toBe(503)
	})

	it('503s when the agent-server call throws', async () => {
		const { app } = build({
			ensure: vi.fn(async () => {
				throw new Error('boom')
			}),
		})
		expect((await post(app)).status).toBe(503)
	})

	it('400s on a malformed workspace header', async () => {
		const { app } = build({ ensure: vi.fn() })
		expect((await post(app, { 'X-Workspace-Id': 'nope' })).status).toBe(400)
	})
})

describe('DELETE /api/desktop', () => {
	beforeEach(() => {})

	it('removes the desktop and records an event', async () => {
		const { app, inserts } = build({ remove: vi.fn(async () => true) })

		const res = await del(app)

		expect(await res.json()).toEqual({ removed: true })
		expect(inserts[0]).toMatchObject({ action: 'deleted', entityType: 'workspace_desktop' })
	})

	it('is a quiet no-op when there is no desktop', async () => {
		const { app, inserts } = build({ remove: vi.fn(async () => false) })

		const res = await del(app)

		expect(await res.json()).toEqual({ removed: false })
		expect(inserts).toHaveLength(0)
	})
})

const control = (app: TestApp, path: string, body?: unknown, query = `?agent_id=${AGENT}`) =>
	app.request(`/api/desktop/${path}${query}`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})

describe('agent control routes', () => {
	beforeEach(() => {})

	it('screenshot returns the desktop image and records no event (it is a read)', async () => {
		const shot = { image_base64: 'abc', mime_type: 'image/jpeg', width: 1280, height: 720 }
		const controlFn = vi.fn(async () => ({ status: 200, body: shot }))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'screenshot')

		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(await res.json()).toEqual(shot)
		expect(controlFn).toHaveBeenCalledWith(WS, AGENT, 'screenshot', {})
		expect(inserts).toHaveLength(0)
	})

	it('input forwards a valid action and audits it without the typed text', async () => {
		const controlFn = vi.fn(async () => ({ status: 200, body: { ok: true } }))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'input', { action: 'type', text: 'hunter2' })

		expect(res.status).toBe(200)
		expect(controlFn).toHaveBeenCalledWith(WS, AGENT, 'input', { action: 'type', text: 'hunter2' })
		expect(inserts).toHaveLength(1)
		expect(inserts[0]).toMatchObject({
			workspaceId: WS,
			actorId: ACTOR,
			action: 'updated',
			entityType: 'workspace_desktop',
			data: { agent_id: AGENT, control: 'input', input_action: 'type' },
		})
		expect(JSON.stringify(inserts[0])).not.toContain('hunter2')
	})

	it('never returns the reply of the desktop to the agent when a typed saved login fails', async () => {
		const SECRET = 'fake-pass-abcdefghij'
		vi.mocked(resolveKeychainTyping).mockResolvedValueOnce({
			kind: 'resolved',
			text: SECRET,
			credentialName: 'Facebook',
			field: 'password',
		})
		// A desktop that echoes the text it was asked to type.
		const controlFn = vi.fn(async (_ws, _agent, _action, sent: { text: string }) => ({
			status: 422,
			body: { error: `cannot type ${sent.text}` },
		}))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'input', {
			action: 'type',
			text: '{{keychain:Facebook.password}}',
		})

		expect(controlFn.mock.calls[0]?.[3]).toEqual({ action: 'type', text: SECRET })
		expect(res.status).toBe(502)
		expect(await res.text()).not.toContain(SECRET)
		expect(inserts).toHaveLength(0)
	})

	it.each([
		['out-of-range x', { action: 'click', x: 5000, y: 10 }],
		['unknown action', { action: 'format-disk' }],
		['non-integer y', { action: 'move', x: 1, y: 1.5 }],
		['shell metacharacters in a key', { action: 'key', keys: ['ctrl+l; rm -rf /'] }],
		['empty text', { action: 'type', text: '' }],
	])('input rejects %s with 400 and never reaches the desktop', async (_name, body) => {
		const controlFn = vi.fn()
		const { app } = build({ control: controlFn })

		expect((await control(app, 'input', body)).status).toBe(400)
		expect(controlFn).not.toHaveBeenCalled()
	})

	it('exec forwards the command and audits it without the command text', async () => {
		const result = { exit_code: 0, stdout: 'hi', stderr: '', timed_out: false }
		const controlFn = vi.fn(async () => ({ status: 200, body: result }))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'exec', { command: 'echo $API_TOKEN' })

		expect(await res.json()).toEqual(result)
		expect(controlFn).toHaveBeenCalledWith(WS, AGENT, 'exec', {
			command: 'echo $API_TOKEN',
			timeout_s: 30,
		})
		expect(inserts[0]).toMatchObject({ data: { agent_id: AGENT, control: 'exec' } })
		expect(JSON.stringify(inserts[0])).not.toContain('API_TOKEN')
	})

	it('exec rejects an over-long timeout', async () => {
		const { app } = build({ control: vi.fn() })

		expect((await control(app, 'exec', { command: 'sleep 1', timeout_s: 9999 })).status).toBe(400)
	})

	it('relays a desktop-side failure and records no event for it', async () => {
		const controlFn = vi.fn(async () => ({
			status: 502,
			body: { error: 'desktop_command_failed' },
		}))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'input', { action: 'move', x: 1, y: 1 })

		expect(res.status).toBe(502)
		expect(inserts).toHaveLength(0)
	})

	it('404s when no desktop could be started and 502s when the agent-server is unreachable', async () => {
		const none = build({ control: vi.fn(async () => null) })
		expect((await control(none.app, 'screenshot')).status).toBe(404)

		const down = build({
			control: vi.fn(async () => {
				throw new Error('ECONNREFUSED')
			}),
		})
		expect((await control(down.app, 'screenshot')).status).toBe(502)
	})
})

// Every agent has its own computer, and what is logged in on it belongs to that
// agent alone: an agent may reach only its own desktop, a person may reach any
// agent's in their workspace but must say whose.
describe('whose computer', () => {
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)
	})

	it('an agent gets its own desktop without naming it', async () => {
		const ensure = vi.fn(async () => ({ server: { id: 's' }, password: 'pw' }))
		const { app } = build({ ensure }, { actorType: 'agent', actorId: AGENT })

		const res = await post(app, {}, '')

		expect(res.status).toBe(200)
		expect(ensure).toHaveBeenCalledWith(WS, AGENT)
	})

	it('refuses an agent that names a colleague, without touching any desktop', async () => {
		const ensure = vi.fn()
		const controlFn = vi.fn()
		const remove = vi.fn()
		const { app } = build(
			{ ensure, control: controlFn, remove },
			{ actorType: 'agent', actorId: AGENT },
		)
		const other = `?agent_id=${OTHER_AGENT}`

		expect((await post(app, {}, other)).status).toBe(403)
		expect((await control(app, 'screenshot', undefined, other)).status).toBe(403)
		expect((await control(app, 'input', { action: 'move', x: 1, y: 1 }, other)).status).toBe(403)
		expect((await control(app, 'exec', { command: 'ls' }, other)).status).toBe(403)
		expect((await del(app, other)).status).toBe(403)
		expect(ensure).not.toHaveBeenCalled()
		expect(controlFn).not.toHaveBeenCalled()
		expect(remove).not.toHaveBeenCalled()
	})

	it('lets an agent name itself explicitly', async () => {
		const ensure = vi.fn(async () => ({ server: { id: 's' }, password: 'pw' }))
		const { app } = build({ ensure }, { actorType: 'agent', actorId: AGENT })

		expect((await post(app, {}, `?agent_id=${AGENT}`)).status).toBe(200)
	})

	it('a person must say whose computer it is', async () => {
		const ensure = vi.fn()
		const { app } = build({ ensure })

		expect((await post(app, {}, '')).status).toBe(400)
		expect(ensure).not.toHaveBeenCalled()
	})

	it('a person can open any agent in the workspace', async () => {
		const ensure = vi.fn(async () => ({ server: { id: 's' }, password: 'pw' }))
		const { app } = build({ ensure })

		expect((await post(app, {}, `?agent_id=${AGENT}`)).status).toBe(200)
		expect(ensure).toHaveBeenCalledWith(WS, AGENT)
	})

	it('404s a person naming an agent that is not in the workspace', async () => {
		const ensure = vi.fn()
		const { app } = build({ ensure }, { agentInWorkspace: false })

		expect((await post(app)).status).toBe(404)
		expect(ensure).not.toHaveBeenCalled()
	})

	it('400s a malformed agent_id', async () => {
		const { app } = build({ ensure: vi.fn() })
		expect((await post(app, {}, '?agent_id=not-a-uuid')).status).toBe(400)
	})

	it('audits which agent a person drove', async () => {
		const controlFn = vi.fn(async () => ({ status: 200, body: { ok: true } }))
		const { app, inserts } = build({ control: controlFn })

		await control(app, 'input', { action: 'key', keys: ['Return'] })

		expect(inserts[0]).toMatchObject({ data: { agent_id: AGENT } })
	})

	describe('GET /api/desktop (who has a computer)', () => {
		const list = (app: TestApp) =>
			app.request('/api/desktop', { headers: { 'X-Workspace-Id': WS } })
		const all = vi.fn(async () => [
			{ agentId: AGENT, status: 'running' as const },
			{ agentId: OTHER_AGENT, status: 'suspended' as const },
		])

		it('shows a person every agent with a computer, and whether it is asleep', async () => {
			const { app } = build({ list: all })

			const res = await list(app)

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({
				desktops: [
					{ agent_id: AGENT, status: 'running' },
					{ agent_id: OTHER_AGENT, status: 'suspended' },
				],
			})
		})

		it('shows an agent only its own, never that colleagues have computers', async () => {
			const { app } = build({ list: all }, { actorType: 'agent', actorId: OTHER_AGENT })

			expect(await (await list(app)).json()).toEqual({
				desktops: [{ agent_id: OTHER_AGENT, status: 'suspended' }],
			})
		})

		it('returns an empty list when a server is down instead of failing', async () => {
			const { app } = build({
				list: vi.fn(async () => {
					throw new Error('down')
				}),
			})

			expect(await (await list(app)).json()).toEqual({ desktops: [] })
		})
	})
})
