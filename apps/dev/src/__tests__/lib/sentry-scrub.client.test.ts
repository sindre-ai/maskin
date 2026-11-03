import { DrizzleQueryError } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Drives the real Sentry client, with the real init options from lib/sentry.ts,
// into a capturing transport. Unit tests on the hook functions alone cannot see
// payloads the SDK builds itself (console breadcrumbs, normalized Error objects).

const envelopes: unknown[] = []

vi.mock('@sentry/node', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@sentry/node')>()
	return {
		...actual,
		init: (options: Parameters<typeof actual.init>[0]) =>
			actual.init({
				...options,
				transport: () => ({
					send: async (envelope: unknown) => {
						envelopes.push(envelope)
						return {}
					},
					flush: async () => true,
				}),
			}),
	}
})

const SQL = 'insert into "tokens" ("hash", "token") values ($1, $2)'
const FAKE_TOKEN = 'fake-token-0000'
const FAKE_HASH = 'fake-hash-1111'
const failedQuery = `Failed query: ${SQL}\nparams: ${FAKE_HASH},${FAKE_TOKEN}`

const ENV_KEYS = ['SENTRY_DSN_DEV', 'SENTRY_FORCE_ENABLE'] as const
const original: Record<string, string | undefined> = {}
let Sentry: typeof import('@sentry/node')
let logger: typeof import('../../lib/logger').logger

const leaked = (text: string) => [FAKE_TOKEN, FAKE_HASH].filter((value) => text.includes(value))

async function sent(action: () => void) {
	envelopes.length = 0
	action()
	await Sentry.flush(2000)
	return JSON.stringify(envelopes)
}

describe('everything the real Sentry client sends is scrubbed', () => {
	beforeAll(async () => {
		for (const key of ENV_KEYS) original[key] = process.env[key]
		process.env.SENTRY_DSN_DEV = 'https://fake@example.invalid/1'
		process.env.SENTRY_FORCE_ENABLE = 'true'
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		;({ Sentry } = await import('../../lib/sentry'))
		;({ logger } = await import('../../lib/logger'))
	})

	afterAll(async () => {
		await Sentry.close()
		vi.restoreAllMocks()
		for (const key of ENV_KEYS) {
			if (original[key] === undefined) delete process.env[key]
			else process.env[key] = original[key]
		}
	})

	it('logger.warn with a failed-query string: log, console breadcrumb and warn breadcrumb', async () => {
		const out = await sent(() => {
			logger.warn('step failed', { error: failedQuery })
			Sentry.captureMessage('after warn', 'error')
		})
		expect(out).toContain('Failed query')
		expect(leaked(out)).toEqual([])
	})

	it('logger.error with a DrizzleQueryError in context: event extra and console breadcrumb', async () => {
		const err = new DrizzleQueryError(SQL, [FAKE_HASH, FAKE_TOKEN], new Error('driver'))
		const out = await sent(() => logger.error('write failed', { err }))
		expect(out).toContain('write failed')
		expect(leaked(out)).toEqual([])
	})

	it('captureException with a DrizzleQueryError', async () => {
		const err = new DrizzleQueryError(SQL, [FAKE_HASH, FAKE_TOKEN], new Error('driver'))
		const out = await sent(() => Sentry.captureException(err))
		expect(out).toContain('Failed query')
		expect(leaked(out)).toEqual([])
	})
})
