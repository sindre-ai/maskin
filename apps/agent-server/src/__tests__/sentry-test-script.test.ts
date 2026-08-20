import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/node', () => ({
	init: vi.fn(),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
	flush: vi.fn(),
}))

const ENV_KEYS = ['SENTRY_DSN_AGENT_SERVER', 'NODE_ENV', 'SENTRY_FORCE_ENABLE'] as const

describe('runSentryTest', () => {
	const original: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of ENV_KEYS) original[key] = process.env[key]
		vi.resetModules()
		vi.resetAllMocks()
	})

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (original[key] === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = original[key]
			}
		}
		vi.resetModules()
		vi.resetAllMocks()
	})

	async function loadRunner() {
		vi.resetModules()
		return import('../scripts/sentry-test')
	}

	it('exits 1 and logs a diagnostic when the DSN is unset', async () => {
		// biome-ignore lint/performance/noDelete: env coercion
		delete process.env.SENTRY_DSN_AGENT_SERVER
		process.env.NODE_ENV = 'production'
		const { runSentryTest } = await loadRunner()
		const err = vi.fn()
		const out = vi.fn()

		const code = await runSentryTest({ ...process.env }, out, err)

		expect(code).toBe(1)
		expect(err).toHaveBeenCalledOnce()
		expect(err.mock.calls[0]?.[0]).toMatch(/not initialised/i)
		expect(out).not.toHaveBeenCalled()
	})

	it('exits 1 when the DSN is set but Sentry init is gated off (not production, no force-enable)', async () => {
		process.env.SENTRY_DSN_AGENT_SERVER = 'https://example.invalid/1'
		process.env.NODE_ENV = 'development'
		// biome-ignore lint/performance/noDelete: env coercion
		delete process.env.SENTRY_FORCE_ENABLE
		const { runSentryTest } = await loadRunner()
		const err = vi.fn()
		const out = vi.fn()

		const code = await runSentryTest({ ...process.env }, out, err)

		expect(code).toBe(1)
		expect(err).toHaveBeenCalledOnce()
	})

	it('captures an exception and flushes when Sentry is enabled — exit 0 on flush success', async () => {
		process.env.SENTRY_DSN_AGENT_SERVER = 'https://example.invalid/1'
		process.env.NODE_ENV = 'production'
		const { runSentryTest } = await loadRunner()
		const Sentry = await import('@sentry/node')
		vi.mocked(Sentry.flush).mockResolvedValueOnce(true)

		const out = vi.fn()
		const err = vi.fn()
		const code = await runSentryTest({ ...process.env }, out, err)

		expect(code).toBe(0)
		expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledOnce()
		const captured = vi.mocked(Sentry.captureException).mock.calls[0]?.[0] as Error | undefined
		expect(captured).toBeInstanceOf(Error)
		expect(captured?.message).toMatch(/Sentry test exception from apps\/agent-server/i)
		expect(vi.mocked(Sentry.flush)).toHaveBeenCalledWith(5000)
		expect(out).toHaveBeenCalledOnce()
	})

	it('exits 2 when Sentry.flush times out (returns false)', async () => {
		process.env.SENTRY_DSN_AGENT_SERVER = 'https://example.invalid/1'
		process.env.NODE_ENV = 'production'
		const { runSentryTest } = await loadRunner()
		const Sentry = await import('@sentry/node')
		vi.mocked(Sentry.flush).mockResolvedValueOnce(false)

		const out = vi.fn()
		const err = vi.fn()
		const code = await runSentryTest({ ...process.env }, out, err)

		expect(code).toBe(2)
		expect(err).toHaveBeenCalledOnce()
		expect(err.mock.calls[0]?.[0]).toMatch(/flush timed out/i)
	})
})
