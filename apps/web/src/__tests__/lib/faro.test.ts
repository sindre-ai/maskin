import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@grafana/faro-web-sdk', () => ({
	initializeFaro: vi.fn(),
	ErrorsInstrumentation: class {},
	WebVitalsInstrumentation: class {},
	ViewInstrumentation: class {},
	SessionInstrumentation: class {},
}))

import {
	__setFaroForTesting,
	initFaro,
	pushFaroError,
	reportApiFailure,
	resetFaroUser,
	setFaroUser,
	setFaroView,
	stripQuery,
} from '@/lib/faro'
import { initializeFaro } from '@grafana/faro-web-sdk'

function createFakeFaro() {
	return {
		api: {
			setView: vi.fn(),
			setUser: vi.fn(),
			resetUser: vi.fn(),
			pushEvent: vi.fn(),
			pushError: vi.fn(),
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double for the Faro surface we use
	} as any
}

let fakeFaro: ReturnType<typeof createFakeFaro>

beforeEach(() => {
	__setFaroForTesting(null)
	fakeFaro = createFakeFaro()
	vi.mocked(initializeFaro).mockReset()
	vi.mocked(initializeFaro).mockReturnValue(fakeFaro)
})

afterEach(() => {
	__setFaroForTesting(null)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

function initWithForceEnable() {
	vi.stubEnv('VITE_FARO_URL', 'https://collector.invalid/collect/abc')
	vi.stubEnv('VITE_FARO_FORCE_ENABLE', 'true')
	initFaro()
	return vi.mocked(initializeFaro).mock.calls[0][0]
}

describe('initFaro gating', () => {
	it('does not init without a collector URL, even with force-enable set', () => {
		vi.stubEnv('VITE_FARO_URL', '')
		vi.stubEnv('VITE_FARO_FORCE_ENABLE', 'true')

		initFaro()

		expect(initializeFaro).not.toHaveBeenCalled()
	})

	it('does not init with a URL set but not enabled (not PROD, no force-enable)', () => {
		vi.stubEnv('VITE_FARO_URL', 'https://collector.invalid/collect/abc')
		vi.stubEnv('VITE_FARO_FORCE_ENABLE', '')

		initFaro()

		expect(initializeFaro).not.toHaveBeenCalled()
	})

	it('inits when a URL is set and VITE_FARO_FORCE_ENABLE=true (the documented escape hatch)', () => {
		const config = initWithForceEnable()

		expect(initializeFaro).toHaveBeenCalledOnce()
		expect(config.url).toBe('https://collector.invalid/collect/abc')
	})

	it('omits apiKey entirely when VITE_FARO_APP_KEY is unset — an empty x-api-key header is worse than none', () => {
		vi.stubEnv('VITE_FARO_APP_KEY', '')

		const config = initWithForceEnable()

		expect(config).not.toHaveProperty('apiKey')
	})

	it('is idempotent — a second call does not re-init', () => {
		initWithForceEnable()
		initFaro()

		expect(initializeFaro).toHaveBeenCalledOnce()
	})

	it('logs to the console and does not throw when initializeFaro itself throws — observability must never break the UI, but must stay discoverable', () => {
		vi.stubEnv('VITE_FARO_URL', 'https://collector.invalid/collect/abc')
		vi.stubEnv('VITE_FARO_FORCE_ENABLE', 'true')
		vi.mocked(initializeFaro).mockImplementation(() => {
			throw new Error('bad config')
		})
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => initFaro()).not.toThrow()
		expect(consoleSpy).toHaveBeenCalledOnce()
	})
})

describe('app version', () => {
	// docker-compose.prod.yml passes Coolify's SOURCE_COMMIT in as this build
	// arg. Until it did, every production build reported the same version, so
	// releases were indistinguishable in Grafana.
	it('reports the build-arg commit sha as the app version', () => {
		vi.stubEnv('VITE_MASKIN_COMMIT_SHA', 'abc123def')

		expect(initWithForceEnable().app?.version).toBe('abc123def')
	})

	it('reports "unknown" rather than a plausible-looking version when the sha is absent', () => {
		vi.stubEnv('VITE_MASKIN_COMMIT_SHA', '')

		expect(initWithForceEnable().app?.version).toBe('unknown')
	})
})

describe('instrumentation selection', () => {
	it('registers exactly the four chosen instrumentations', () => {
		const names = initWithForceEnable().instrumentations?.map((i) => i.constructor.name)

		expect(names).toEqual([
			'ErrorsInstrumentation',
			'WebVitalsInstrumentation',
			'ViewInstrumentation',
			'SessionInstrumentation',
		])
	})

	it('does not enable the console instrumentation — our console output carries free-text app data', () => {
		const names = initWithForceEnable().instrumentations?.map((i) => i.constructor.name) ?? []

		expect(names).not.toContain('ConsoleInstrumentation')
	})
})

describe('PII scrubbing', () => {
	it('stripQuery drops the query string and hash but keeps the path', () => {
		expect(stripQuery('https://app.example/objects/search?q=secret+text#frag')).toBe(
			'https://app.example/objects/search',
		)
	})

	it('beforeSend strips the query from a signal page url before it leaves the browser', () => {
		const beforeSend = initWithForceEnable().beforeSend
		const item = {
			meta: { page: { url: 'https://app.example/ws/1/objects?q=board+meeting+notes' } },
			// biome-ignore lint/suspicious/noExplicitAny: partial TransportItem is all beforeSend touches
		} as any

		beforeSend?.(item)

		expect(item.meta.page.url).toBe('https://app.example/ws/1/objects')
	})

	it('setFaroUser sends ids only — never email, username or full name', () => {
		__setFaroForTesting(fakeFaro)

		setFaroUser('actor-1', 'workspace-1')

		expect(fakeFaro.api.setUser).toHaveBeenCalledWith({
			id: 'actor-1',
			attributes: { workspace_id: 'workspace-1' },
		})
		const sent = fakeFaro.api.setUser.mock.calls[0][0]
		expect(sent).not.toHaveProperty('email')
		expect(sent).not.toHaveProperty('username')
		expect(sent).not.toHaveProperty('fullName')
	})

	it('reportApiFailure strips the query string from the reported path', () => {
		__setFaroForTesting(fakeFaro)

		reportApiFailure({ method: 'GET', path: '/objects/search?q=acquisition+terms', status: 500 })

		expect(fakeFaro.api.pushEvent).toHaveBeenCalledWith('api_request_failed', {
			method: 'GET',
			path: '/objects/search',
			status: '500',
		})
	})

	it('reportApiFailure includes the structured error code when the backend supplied one', () => {
		__setFaroForTesting(fakeFaro)

		reportApiFailure({ method: 'POST', path: '/sessions', status: 402, code: 'PLAN_CAP_EXCEEDED' })

		expect(fakeFaro.api.pushEvent).toHaveBeenCalledWith('api_request_failed', {
			method: 'POST',
			path: '/sessions',
			status: '402',
			code: 'PLAN_CAP_EXCEEDED',
		})
	})
})

describe('no-ops before init', () => {
	it('every reporting helper is a no-op until Faro is initialised', () => {
		setFaroView('/_authed/$workspaceId')
		setFaroUser('actor-1', 'workspace-1')
		resetFaroUser()
		reportApiFailure({ method: 'GET', path: '/objects', status: 500 })
		pushFaroError(new Error('boom'))

		expect(fakeFaro.api.setView).not.toHaveBeenCalled()
		expect(fakeFaro.api.setUser).not.toHaveBeenCalled()
		expect(fakeFaro.api.resetUser).not.toHaveBeenCalled()
		expect(fakeFaro.api.pushEvent).not.toHaveBeenCalled()
		expect(fakeFaro.api.pushError).not.toHaveBeenCalled()
	})
})

describe('reporting helpers once initialised', () => {
	beforeEach(() => __setFaroForTesting(fakeFaro))

	it('setFaroView names the view by TanStack route id', () => {
		setFaroView('/_authed/$workspaceId/objects/$objectId')

		expect(fakeFaro.api.setView).toHaveBeenCalledWith({
			name: '/_authed/$workspaceId/objects/$objectId',
		})
	})

	it('pushFaroError forwards the error', () => {
		const error = new Error('boom')

		pushFaroError(error)

		expect(fakeFaro.api.pushError).toHaveBeenCalledWith(error)
	})

	it('logs to the console and does not throw when the Faro API itself throws', () => {
		fakeFaro.api.pushError.mockImplementation(() => {
			throw new Error('faro down')
		})
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => pushFaroError(new Error('boom'))).not.toThrow()
		expect(consoleSpy).toHaveBeenCalledOnce()
	})
})
