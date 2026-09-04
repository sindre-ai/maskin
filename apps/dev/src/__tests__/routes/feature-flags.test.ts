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

const ENV_KEYS = ['FF_TESTER_ACTOR_IDS', 'FF_TESTER_FEATURES'] as const

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
	for (const key of ENV_KEYS) {
		if (vars[key] === undefined) delete process.env[key]
		else process.env[key] = vars[key]
	}
	// The config is memoized; drop it so this test's env is the one that's read.
	_resetFeatureFlagConfig()
}

// The shape of the response body when every registered flag is OFF. Add
// entries here as new flags land in FLAGS so a shipped-off default is exercised.
const ALL_FLAGS_OFF = {
	[FLAGS.LINKEDIN_ADDON_VISIBLE]: false,
	[FLAGS.SALES_REP_LINKEDIN_AUTOSEND]: false,
}

beforeEach(() => setEnv({}))
afterEach(() => setEnv({}))

describe('GET /api/feature-flags', () => {
	// Every registered flag resolves, and defaults off when no env is set.
	it('resolves the live registry when no env is set', async () => {
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ flags: ALL_FLAGS_OFF })
	})

	it('turns a registered flag on for a listed tester', async () => {
		setEnv({ FF_TESTER_FEATURES: FLAGS.LINKEDIN_ADDON_VISIBLE, FF_TESTER_ACTOR_IDS: TESTER })
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(await res.json()).toEqual({
			flags: { ...ALL_FLAGS_OFF, [FLAGS.LINKEDIN_ADDON_VISIBLE]: true },
		})
	})

	// Task 5 acceptance criterion 1 — the LinkedIn autosend flag defaults OFF
	// and only turns ON via the same tester-scoped env pair as any other flag.
	it('turns SALES_REP_LINKEDIN_AUTOSEND on for a listed tester', async () => {
		setEnv({
			FF_TESTER_FEATURES: FLAGS.SALES_REP_LINKEDIN_AUTOSEND,
			FF_TESTER_ACTOR_IDS: TESTER,
		})
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(await res.json()).toEqual({
			flags: { ...ALL_FLAGS_OFF, [FLAGS.SALES_REP_LINKEDIN_AUTOSEND]: true },
		})
	})

	it('never invents a flag from an unregistered id in FF_TESTER_FEATURES', async () => {
		setEnv({ FF_TESTER_FEATURES: 'not-a-real-flag', FF_TESTER_ACTOR_IDS: TESTER })
		const { app } = createTestApp(featureFlagsRoutes, '/api/feature-flags', TESTER)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(await res.json()).toEqual({ flags: ALL_FLAGS_OFF })
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

	it('returns 401 when the request is unauthenticated', async () => {
		const { db } = createTestContext()
		const app = new OpenAPIHono()
		app.use('/api/*', authMiddleware(db))
		app.route('/api/feature-flags', featureFlagsRoutes)

		const res = await app.request(jsonGet('/api/feature-flags'))
		expect(res.status).toBe(401)
	})
})
