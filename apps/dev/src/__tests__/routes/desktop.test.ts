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
