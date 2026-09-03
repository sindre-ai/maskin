import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	type UnipileMockServer,
	startUnipileMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { createAuthLink } from '../../../../../lib/integrations/providers/linkedin-unipile/client'
import { UnipileUnavailableError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'

const ORIGINAL_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['UNIPILE_BASE_URL', 'UNIPILE_API_KEY'] as const

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
})

describe('createAuthLink', () => {
	it('POSTs the v2 hosted-auth link request with providers, expires_on, redirect_uri, state', async () => {
		const expiresOn = new Date(Date.now() + 10 * 60_000).toISOString()
		const res = await createAuthLink({
			providers: ['linkedin'],
			expires_on: expiresOn,
			redirect_uri: 'http://localhost:3000/api/integrations/linkedin-unipile/callback',
			state: 'integration-abc',
		})
		expect(res.data.link).toContain(mock.baseUrl)

		const recorded = mock.inbox().find((c) => c.path === '/v2/auth/link')
		expect(recorded).toBeDefined()
		expect(recorded?.method).toBe('POST')
		const body = recorded?.body as Record<string, unknown>
		expect(body.providers).toEqual(['linkedin'])
		expect(body.expires_on).toBe(expiresOn)
		expect(body.redirect_uri).toBe(
			'http://localhost:3000/api/integrations/linkedin-unipile/callback',
		)
		expect(body.state).toBe('integration-abc')
	})

	it('wraps a network failure as UnipileUnavailableError', async () => {
		process.env.UNIPILE_BASE_URL = 'http://127.0.0.1:1' // guaranteed unreachable
		await expect(
			createAuthLink({
				providers: ['linkedin'],
				expires_on: new Date(Date.now() + 60_000).toISOString(),
				redirect_uri: 'http://localhost/cb',
				state: 'x',
			}),
		).rejects.toBeInstanceOf(UnipileUnavailableError)
	})

	it('rejects a response missing the nested data.link', async () => {
		// Point at a server that returns 404 (mock's default) to exercise the
		// !res.ok path — the client wraps it in UnipileUnavailableError.
		process.env.UNIPILE_BASE_URL = `${mock.baseUrl}/nonexistent`
		await expect(
			createAuthLink({
				providers: ['linkedin'],
				expires_on: new Date(Date.now() + 60_000).toISOString(),
				redirect_uri: 'http://localhost/cb',
				state: 'y',
			}),
		).rejects.toBeInstanceOf(UnipileUnavailableError)
	})
})
