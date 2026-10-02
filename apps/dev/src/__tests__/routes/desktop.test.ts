import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/feature-flags', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/feature-flags')>()),
	isFlagEnabledForWorkspace: vi.fn(),
}))

import { consumeDesktopTicket } from '../../lib/desktop-ticket'
import { isFlagEnabledForWorkspace } from '../../lib/feature-flags'
import desktopRoutes from '../../routes/desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'test-actor-id'

function build(service: Record<string, unknown>) {
	const inserts: unknown[] = []
	const db = {
		insert: () => ({
			values: async (row: unknown) => {
				inserts.push(row)
			},
		}),
	}
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', ACTOR)
		c.set('desktopService', service)
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return { app, inserts }
}

type TestApp = ReturnType<typeof build>['app']

const post = (app: TestApp, headers: Record<string, string> = {}) =>
	app.request('/api/desktop/connect', {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, ...headers },
	})

const del = (app: TestApp) =>
	app.request('/api/desktop', { method: 'DELETE', headers: { 'X-Workspace-Id': WS } })

describe('POST /api/desktop/connect', () => {
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)
		vi.mocked(isFlagEnabledForWorkspace).mockReturnValue(true)
	})

	it('returns a ticket bound to the workspace and actor, plus the VNC password', async () => {
		const { app } = build({
			ensure: vi.fn(async () => ({ server: { id: 's' }, password: 'pw' })),
		})

		const res = await post(app)
		const body = (await res.json()) as { ticket: string; path: string; password: string }

		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(body.password).toBe('pw')
		expect(body.path).toBe('/api/desktop/stream')
		expect(consumeDesktopTicket(body.ticket)).toEqual({ workspaceId: WS, actorId: ACTOR })
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

	it('404s when the flag is off and never touches an agent-server', async () => {
		vi.mocked(isFlagEnabledForWorkspace).mockReturnValue(false)
		const ensure = vi.fn()
		const { app } = build({ ensure })

		expect((await post(app)).status).toBe(404)
		expect(ensure).not.toHaveBeenCalled()
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
	beforeEach(() => {
		vi.mocked(isFlagEnabledForWorkspace).mockReturnValue(true)
	})

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

	it('404s when the flag is off', async () => {
		vi.mocked(isFlagEnabledForWorkspace).mockReturnValue(false)
		const remove = vi.fn()
		const { app } = build({ remove })

		expect((await del(app)).status).toBe(404)
		expect(remove).not.toHaveBeenCalled()
	})
})

const control = (app: TestApp, path: string, body?: unknown) =>
	app.request(`/api/desktop/${path}`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})

describe('agent control routes', () => {
	beforeEach(() => {
		vi.mocked(isFlagEnabledForWorkspace).mockReturnValue(true)
	})

	it('404s every control route without touching the service when the flag is off', async () => {
		vi.mocked(isFlagEnabledForWorkspace).mockReturnValue(false)
		const controlFn = vi.fn()
		const { app } = build({ control: controlFn })

		for (const [path, body] of [
			['screenshot', undefined],
			['input', { action: 'move', x: 1, y: 1 }],
			['exec', { command: 'ls' }],
		] as const) {
			expect((await control(app, path, body)).status).toBe(404)
		}
		expect(controlFn).not.toHaveBeenCalled()
	})

	it('screenshot returns the desktop image and records no event (it is a read)', async () => {
		const shot = { image_base64: 'abc', mime_type: 'image/jpeg', width: 1280, height: 720 }
		const controlFn = vi.fn(async () => ({ status: 200, body: shot }))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'screenshot')

		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(await res.json()).toEqual(shot)
		expect(controlFn).toHaveBeenCalledWith(WS, 'screenshot', {})
		expect(inserts).toHaveLength(0)
	})

	it('input forwards a valid action and audits it without the typed text', async () => {
		const controlFn = vi.fn(async () => ({ status: 200, body: { ok: true } }))
		const { app, inserts } = build({ control: controlFn })

		const res = await control(app, 'input', { action: 'type', text: 'hunter2' })

		expect(res.status).toBe(200)
		expect(controlFn).toHaveBeenCalledWith(WS, 'input', { action: 'type', text: 'hunter2' })
		expect(inserts).toHaveLength(1)
		expect(inserts[0]).toMatchObject({
			workspaceId: WS,
			actorId: ACTOR,
			action: 'updated',
			entityType: 'workspace_desktop',
			data: { control: 'input', input_action: 'type' },
		})
		expect(JSON.stringify(inserts[0])).not.toContain('hunter2')
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
		expect(controlFn).toHaveBeenCalledWith(WS, 'exec', {
			command: 'echo $API_TOKEN',
			timeout_s: 30,
		})
		expect(inserts[0]).toMatchObject({ data: { control: 'exec' } })
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
