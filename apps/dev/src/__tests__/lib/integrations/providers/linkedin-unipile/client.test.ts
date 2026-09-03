import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	type UnipileMockServer,
	startUnipileMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import {
	createHostedAuthLink,
	verifyWebhookSignature,
} from '../../../../../lib/integrations/providers/linkedin-unipile/client'
import { UnipileUnavailableError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'

const WEBHOOK_SECRET = 'test-secret'
const ORIGINAL_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['UNIPILE_BASE_URL', 'UNIPILE_API_KEY', 'UNIPILE_WEBHOOK_SECRET'] as const

let mock: UnipileMockServer

beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	mock = await startUnipileMock()
})

afterAll(async () => {
	await mock.close()
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
		else process.env[key] = ORIGINAL_ENV[key]
	}
})

beforeEach(() => {
	mock.resetInbox()
	process.env.UNIPILE_BASE_URL = mock.baseUrl
	process.env.UNIPILE_API_KEY = 'test-api-key'
	process.env.UNIPILE_WEBHOOK_SECRET = WEBHOOK_SECRET
})

describe('createHostedAuthLink', () => {
	it('POSTs the LinkedIn provider scope + round-trip name and returns a URL', async () => {
		const res = await createHostedAuthLink({
			name: 'integration-abc',
			apiUrl: 'http://localhost:3000/api/integrations/linkedin-unipile/callback',
			notifyUrl: 'http://localhost:3000/api/integrations/linkedin-unipile/callback',
		})
		expect(res.url).toContain(mock.baseUrl)
		const recorded = mock.inbox().find((c) => c.path === '/api/v1/hosted/accounts/link')
		expect(recorded).toBeDefined()
		const body = recorded?.body as Record<string, unknown>
		expect(body.providers).toEqual(['LINKEDIN'])
		expect(body.name).toBe('integration-abc')
		expect(body.api_url).toBe('http://localhost:3000/api/integrations/linkedin-unipile/callback')
	})

	it('wraps a network failure as UnipileUnavailableError', async () => {
		process.env.UNIPILE_BASE_URL = 'http://127.0.0.1:1' // guaranteed unreachable
		await expect(
			createHostedAuthLink({
				name: 'x',
				apiUrl: 'http://localhost/cb',
				notifyUrl: 'http://localhost/cb',
			}),
		).rejects.toBeInstanceOf(UnipileUnavailableError)
	})
})

describe('verifyWebhookSignature', () => {
	it('accepts a valid HMAC-SHA256 hex signature', () => {
		const body = '{"status":"CREATION_SUCCESS"}'
		const sig = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')
		expect(verifyWebhookSignature(body, sig)).toBe(true)
	})

	it('accepts a signature with a "sha256=" prefix', () => {
		const body = '{"a":1}'
		const sig = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')
		expect(verifyWebhookSignature(body, `sha256=${sig}`)).toBe(true)
	})

	it('rejects a tampered body', () => {
		const body = '{"a":1}'
		const sig = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')
		expect(verifyWebhookSignature('{"a":2}', sig)).toBe(false)
	})

	it('rejects a missing signature header', () => {
		expect(verifyWebhookSignature('body', null)).toBe(false)
		expect(verifyWebhookSignature('body', '')).toBe(false)
	})

	it('rejects when the secret is unset', () => {
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.UNIPILE_WEBHOOK_SECRET
		expect(verifyWebhookSignature('body', 'deadbeef')).toBe(false)
	})
})
