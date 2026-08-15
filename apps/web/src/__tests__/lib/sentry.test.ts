import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/react', () => ({
	init: vi.fn(),
	captureException: vi.fn(),
}))

import { __setInitializedForTesting, captureException, initSentry } from '@/lib/sentry'
import * as Sentry from '@sentry/react'

beforeEach(() => {
	__setInitializedForTesting(false)
	vi.mocked(Sentry.init).mockReset()
	vi.mocked(Sentry.captureException).mockReset()
})

afterEach(() => {
	__setInitializedForTesting(false)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe('initSentry gating', () => {
	it('does not init without a DSN, even with force-enable set', () => {
		vi.stubEnv('VITE_SENTRY_DSN', '')
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', 'true')

		initSentry()

		expect(Sentry.init).not.toHaveBeenCalled()
	})

	it('does not init with a DSN set but not enabled (not PROD, no force-enable)', () => {
		vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/1')
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', '')

		initSentry()

		expect(Sentry.init).not.toHaveBeenCalled()
	})

	it('inits when a DSN is set and VITE_SENTRY_FORCE_ENABLE=true (the documented escape hatch)', () => {
		vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/1')
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', 'true')

		initSentry()

		expect(Sentry.init).toHaveBeenCalledOnce()
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({ dsn: 'https://example.invalid/1', sendDefaultPii: false }),
		)
	})

	it('is idempotent — a second call does not re-init', () => {
		vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/1')
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', 'true')

		initSentry()
		initSentry()

		expect(Sentry.init).toHaveBeenCalledOnce()
	})

	it('logs to the console and does not throw when Sentry.init itself throws — reporting must never break the UI, but must stay discoverable', () => {
		vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/1')
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', 'true')
		vi.mocked(Sentry.init).mockImplementation(() => {
			throw new Error('bad config')
		})
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => initSentry()).not.toThrow()
		expect(consoleSpy).toHaveBeenCalledOnce()
	})
})

describe('captureException', () => {
	it('is a no-op before initSentry has succeeded', () => {
		captureException(new Error('boom'))

		expect(Sentry.captureException).not.toHaveBeenCalled()
	})

	it('forwards to Sentry.captureException once initialized', () => {
		__setInitializedForTesting(true)
		const error = new Error('boom')

		captureException(error)

		expect(Sentry.captureException).toHaveBeenCalledOnce()
		expect(Sentry.captureException).toHaveBeenCalledWith(error)
	})

	it('logs to the console and does not throw when Sentry.captureException itself throws', () => {
		__setInitializedForTesting(true)
		vi.mocked(Sentry.captureException).mockImplementation(() => {
			throw new Error('sentry down')
		})
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => captureException(new Error('boom'))).not.toThrow()
		expect(consoleSpy).toHaveBeenCalledOnce()
	})
})
