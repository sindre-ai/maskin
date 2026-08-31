import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/node', () => ({
	init: vi.fn(),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
	setUser: vi.fn(),
	setTag: vi.fn(),
}))

const ENV_KEYS = ['SENTRY_DSN_DEV', 'NODE_ENV', 'SENTRY_FORCE_ENABLE'] as const

describe('lib/sentry (apps/dev) init gating', () => {
	const original: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of ENV_KEYS) original[key] = process.env[key]
	})

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (original[key] === undefined) delete process.env[key]
			else process.env[key] = original[key]
		}
		vi.resetModules()
		vi.clearAllMocks()
	})

	async function loadSentryModule() {
		vi.resetModules()
		return import('../../lib/sentry')
	}

	it('does not init when no DSN is set, even in production', async () => {
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.SENTRY_DSN_DEV
		process.env.NODE_ENV = 'production'
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.SENTRY_FORCE_ENABLE
		const { Sentry } = await loadSentryModule()
		expect(Sentry.init).not.toHaveBeenCalled()
	})

	it('does not init in development with a DSN set and no force-enable', async () => {
		process.env.SENTRY_DSN_DEV = 'https://example.invalid/1'
		process.env.NODE_ENV = 'development'
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.SENTRY_FORCE_ENABLE
		const { Sentry } = await loadSentryModule()
		expect(Sentry.init).not.toHaveBeenCalled()
	})

	it('inits when a DSN is set and NODE_ENV=production', async () => {
		process.env.SENTRY_DSN_DEV = 'https://example.invalid/1'
		process.env.NODE_ENV = 'production'
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.SENTRY_FORCE_ENABLE
		const { Sentry } = await loadSentryModule()
		expect(Sentry.init).toHaveBeenCalledOnce()
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({ dsn: 'https://example.invalid/1', sendDefaultPii: false }),
		)
	})

	it('inits outside production when SENTRY_FORCE_ENABLE=true (the documented escape hatch)', async () => {
		process.env.SENTRY_DSN_DEV = 'https://example.invalid/1'
		process.env.NODE_ENV = 'development'
		process.env.SENTRY_FORCE_ENABLE = 'true'
		const { Sentry } = await loadSentryModule()
		expect(Sentry.init).toHaveBeenCalledOnce()
	})
})

describe('resolveClientSourceTag', () => {
	async function load() {
		const mod = await import('../../lib/sentry')
		return mod.resolveClientSourceTag
	}

	it('passes through each known client source', async () => {
		const resolve = await load()
		for (const source of ['ui', 'mcp', 'agent', 'extension']) {
			expect(resolve(source)).toBe(source)
		}
	})

	it('normalizes case and surrounding whitespace', async () => {
		const resolve = await load()
		expect(resolve('  MCP ')).toBe('mcp')
	})

	it('reports unknown when the header is absent', async () => {
		const resolve = await load()
		expect(resolve(undefined)).toBe('unknown')
		expect(resolve('')).toBe('unknown')
	})

	it('collapses unrecognised values to other rather than passing them through', async () => {
		const resolve = await load()
		// The header is caller-supplied, so arbitrary text must never reach
		// Sentry as a tag — that would blow up tag cardinality and could
		// smuggle personal data into the error store.
		expect(resolve('curl/8.4.0')).toBe('other')
		expect(resolve('alice@example.com')).toBe('other')
	})
})
