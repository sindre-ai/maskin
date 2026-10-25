import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLAGS, _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { jsonGet } from '../helpers'
import { createTestApp, createTestContext } from '../setup'

const { default: featureFlagsRoutes } = await import('../../routes/feature-flags')

const TESTER = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const NON_TESTER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const ENV_KEYS = ['FF_TESTER_ACTOR_IDS', 'FF_TESTER_FEATURES', 'FF_WORKSPACE_FEATURES'] as const

const WORKSPACE_A = 'e2877e32-2c11-489e-96c8-a76200908ed4'
const WORKSPACE_B = 'f79e3751-c680-47e0-9a9a-824a4a2a7908'

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
	for (const key of ENV_KEYS) {
		if (vars[key] === undefined) delete process.env[key]
		else process.env[key] = vars[key]
	}
	// The config is memoized; drop it so this test's env is the one that's read.
	_resetFeatureFlagConfig()
}

beforeEach(() => setEnv({}))
afterEach(() => setEnv({}))

// Every registered flag, off. Derived from FLAGS rather than hardcoded so a
// flag being added or retired doesn't break these cases — the invariant under
// test is "off unless the env turns it on", not the size of the registry.
const ALL_OFF = Object.fromEntries(Object.values(FLAGS).map((id) => [id, false]))

describe('GET /api/feature-flags', () => {
	// Every registered flag resolves, and defaults off when no env is set.
	it('resolves every registered flag as off when no env is set', async () => {
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ flags: ALL_OFF })
	})

	// A flag only turns ON via the tester-scoped env pair.
	it('turns TRIGGER_ENGINE_V2 on for a listed tester', async () => {
		setEnv({
			FF_TESTER_FEATURES: FLAGS.TRIGGER_ENGINE_V2,
			FF_TESTER_ACTOR_IDS: TESTER,
		})
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(await res.json()).toEqual({
			flags: { ...ALL_OFF, [FLAGS.TRIGGER_ENGINE_V2]: true },
		})
	})

	it('never invents a flag from an unregistered id in FF_TESTER_FEATURES', async () => {
		setEnv({ FF_TESTER_FEATURES: 'not-a-real-flag', FF_TESTER_ACTOR_IDS: TESTER })
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		const body = (await res.json()) as { flags: Record<string, boolean> }
		expect(body.flags).toEqual(ALL_OFF)
		expect('not-a-real-flag' in body.flags).toBe(false)
	})

	it('sets Cache-Control: no-store so a rollback is not defeated by a stale cache', async () => {
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(res.headers.get('Cache-Control')).toBe('no-store')
	})

	// The whole point of resolving server-side is that tester identities never
	// reach the browser.
	it('never leaks actor uuids or raw config into the response body', async () => {
		setEnv({
			FF_TESTER_FEATURES: 'some-flag',
			FF_TESTER_ACTOR_IDS: `${TESTER},${NON_TESTER}`,
		})
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		const raw = JSON.stringify(await res.json())

		expect(raw).not.toMatch(UUID_RE)
		expect(raw).not.toContain(TESTER)
		expect(raw).not.toContain(NON_TESTER)
		expect(raw).not.toContain('FF_')
		expect(raw).not.toContain('testerActorIds')
	})

	describe('with an X-Workspace-Id header', () => {
		const FLAG = FLAGS.GROUP_CHAT_WAKE_RULE
		const memberRow = { actorId: TESTER }

		// Flag on for workspace A only. TESTER is neither a tester nor listed anywhere else.
		beforeEach(() => setEnv({ FF_WORKSPACE_FEATURES: `${WORKSPACE_A}:${FLAG}` }))

		it('covers the workspace flags when the caller is a member of it', async () => {
			const { app, mockResults } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)
			mockResults.select = [memberRow]

			const res = await app.request(
				jsonGet('/api/feature-flags', { 'X-Workspace-Id': WORKSPACE_A }),
			)
			expect(await res.json()).toEqual({ flags: { ...ALL_OFF, [FLAG]: true } })
		})

		it('says false for a workspace the flag is not on for, even to a member of both', async () => {
			const { app, mockResults } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)
			mockResults.select = [memberRow]

			const forA = await app.request(
				jsonGet('/api/feature-flags', { 'X-Workspace-Id': WORKSPACE_A }),
			)
			const forB = await app.request(
				jsonGet('/api/feature-flags', { 'X-Workspace-Id': WORKSPACE_B }),
			)
			expect(((await forA.json()) as { flags: Record<string, boolean> }).flags[FLAG]).toBe(true)
			expect(((await forB.json()) as { flags: Record<string, boolean> }).flags[FLAG]).toBe(false)
		})

		it('gives a non-member the actor-only answer, never the workspace flags', async () => {
			const { app, mockResults } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)
			mockResults.select = []

			const res = await app.request(
				jsonGet('/api/feature-flags', { 'X-Workspace-Id': WORKSPACE_A }),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ flags: ALL_OFF })
		})

		it('ignores a header that is not a workspace id', async () => {
			const { app, mockResults } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)
			mockResults.select = [memberRow]

			const res = await app.request(
				jsonGet('/api/feature-flags', { 'X-Workspace-Id': 'not-a-uuid' }),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ flags: ALL_OFF })
		})

		it("returns today's answer unchanged when no header is sent", async () => {
			const { app, mockResults } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)
			mockResults.select = [memberRow]

			const res = await app.request(jsonGet('/api/feature-flags'))
			expect(await res.json()).toEqual({ flags: ALL_OFF })
		})

		it('does not turn the flag on for a tester listed for it', async () => {
			setEnv({ FF_TESTER_ACTOR_IDS: TESTER, FF_TESTER_FEATURES: FLAG })
			const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

			const res = await app.request(jsonGet('/api/feature-flags'))
			expect(await res.json()).toEqual({ flags: ALL_OFF })
		})
	})

	it('returns 401 when the request is unauthenticated', async () => {
		const { db } = createTestContext()
		const app = new OpenAPIHono()
		app.use('/api/*', authMiddleware(db))
		app.route('/api/feature-flags', featureFlagsRoutes)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(res.status).toBe(401)
	})
})
