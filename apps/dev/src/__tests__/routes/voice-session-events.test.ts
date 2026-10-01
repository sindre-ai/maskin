import type { NodeWebSocket } from '@hono/node-ws'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { createVoiceSessionEventsRoutes } from '../../routes/voice-session-events'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const HUMAN = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const OTHER_HUMAN = '7d0f5c6e-df81-4365-8fa2-9e4b1f35c886'
const AGENT = '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553'
const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const SESSION_ID = '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664'

const ENV_KEYS = ['FF_TESTER_ACTOR_IDS', 'FF_TESTER_FEATURES'] as const

function setFlag(on: boolean) {
	const vars: Record<(typeof ENV_KEYS)[number], string | undefined> = {
		FF_TESTER_ACTOR_IDS: on ? HUMAN : undefined,
		FF_TESTER_FEATURES: on ? 'voice-mode-v1' : undefined,
	}
	for (const key of ENV_KEYS) {
		const value = vars[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	_resetFeatureFlagConfig()
}

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
	id: SESSION_ID,
	workspaceId: WORKSPACE,
	agentActorId: AGENT,
	humanActorId: HUMAN,
	conversationId: null,
	status: 'pending',
	...overrides,
})

// Stands in for @hono/node-ws: proves the preflight let the request through to
// the upgrade, and hands the events factory the context it would receive.
const createEvents = vi.fn()
const fakeUpgrade = ((factory: (c: unknown) => unknown) =>
	createMiddleware(async (c) => {
		createEvents(factory(c))
		return c.text('upgraded')
	})) as unknown as NodeWebSocket['upgradeWebSocket']

function build() {
	const invokeFactory = vi.fn()
	const routes = createVoiceSessionEventsRoutes(fakeUpgrade, invokeFactory)
	const ctx = createTestApp(routes as unknown as OpenAPIHono, '/api/voice-sessions', HUMAN)
	return { ...ctx, invokeFactory }
}

const get = (app: ReturnType<typeof build>['app'], id = SESSION_ID) =>
	app.request(jsonGet(`/api/voice-sessions/${id}/events`))

beforeEach(() => {
	setFlag(true)
	createEvents.mockReset()
})
afterEach(() => setFlag(false))

describe('GET /api/voice-sessions/:id/events — preflight before the upgrade', () => {
	it('404s when the voice-mode-v1 flag is off for the caller', async () => {
		setFlag(false)
		const { app } = build()
		expect((await get(app)).status).toBe(404)
		expect(createEvents).not.toHaveBeenCalled()
	})

	it('404s on an id that is not a uuid', async () => {
		const { app } = build()
		expect((await get(app, 'not-a-uuid')).status).toBe(404)
	})

	it('404s when the session does not exist', async () => {
		const { app, mockResults } = build()
		mockResults.selectQueue = [[]]
		expect((await get(app)).status).toBe(404)
	})

	it('404s, not 403s, on another human’s session so ids cannot be probed', async () => {
		const { app, mockResults } = build()
		mockResults.selectQueue = [[sessionRow({ humanActorId: OTHER_HUMAN })]]
		expect((await get(app)).status).toBe(404)
		expect(createEvents).not.toHaveBeenCalled()
	})

	it('404s when the caller is no longer a member of the session workspace', async () => {
		const { app, mockResults } = build()
		mockResults.selectQueue = [[sessionRow()], []]
		expect((await get(app)).status).toBe(404)
	})

	it.each(['ended', 'errored', 'timed_out'])('409s when the session is %s', async (status) => {
		const { app, mockResults } = build()
		mockResults.selectQueue = [[sessionRow({ status })], [{ actorId: HUMAN }]]
		expect((await get(app)).status).toBe(409)
		expect(createEvents).not.toHaveBeenCalled()
	})

	it('500s without upgrading when the agent has no API key to attribute writes to', async () => {
		const { app, mockResults } = build()
		mockResults.selectQueue = [
			[sessionRow()],
			[{ actorId: HUMAN }],
			[{ name: 'Chief of Staff', apiKey: null }],
		]
		expect((await get(app)).status).toBe(500)
		expect(createEvents).not.toHaveBeenCalled()
	})

	it.each(['pending', 'active'])('upgrades a %s session for its own human', async (status) => {
		const { app, mockResults } = build()
		mockResults.selectQueue = [
			[sessionRow({ status })],
			[{ actorId: HUMAN }],
			[{ name: 'Chief of Staff', apiKey: 'ank_agentkey' }],
		]
		const res = await get(app)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('upgraded')
		expect(createEvents).toHaveBeenCalledTimes(1)
	})
})
