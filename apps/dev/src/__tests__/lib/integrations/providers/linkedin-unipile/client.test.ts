import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	type UnipileMockServer,
	startUnipileMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import {
	CreateAuthLinkResponseSchema,
	createAuthLink,
} from '../../../../../lib/integrations/providers/linkedin-unipile/client'
import { UnipileUnavailableError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'
import { createUnipileHttpClient } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

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
		expect(res.link).toContain(mock.baseUrl)

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

	// The mock is the only payload the tests above exercise, so a schema that
	// agrees with the mock and disagrees with Unipile passes everything while
	// every real connect 500s. Pin the schema to a payload captured verbatim
	// from api.unipile.com so the two cannot drift together.
	it('accepts the literal v2 response shape returned by api.unipile.com', () => {
		const live = {
			object: 'HostedAuthLink',
			link: 'https://auth.unipile.com/?token=GqdGwgnw.BwWSmuBA4H7upviYaYs2uCiNvvVRW5eI3kN3h65en%2Fs%3D',
		}
		const parsed = CreateAuthLinkResponseSchema.safeParse(live)
		expect(parsed.success).toBe(true)
	})

	it('rejects the v1-style nested {data:{link}} shape', () => {
		const parsed = CreateAuthLinkResponseSchema.safeParse({
			data: { link: 'https://auth.unipile.com/?token=abc' },
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects a response missing the top-level link', async () => {
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

/**
 * Route-shape tests for the read surface.
 *
 * Every LinkedIn bug found in live testing so far has been a wrong PATH, not
 * wrong logic: `data.link` vs `link`, `/chats` (501) vs
 * `/inboxes/:id/chats`, and `/users/relations` — which answers 200 with one
 * unrelated profile because it collides with `/users/:identifier`. These
 * assert the exact path each method calls, against the mock's recorded inbox.
 */
describe('read-surface routes', () => {
	function client() {
		return createUnipileHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
	}
	const account_id = 'acc_1'

	it('reads a thread from /chats/:chat_id/messages', async () => {
		const res = await client().listMessages({ account_id, chat_id: 'chat-1', limit: 5 })
		expect(res.status).toBe(200)
		const call = mock.inbox().at(-1)
		expect(call?.method).toBe('GET')
		expect(call?.path).toBe('/v2/acc_1/chats/chat-1/messages?limit=5')
	})

	// The collision that makes the wrong path silently succeed on the live API.
	it('reads connections from /users/me/relations, NOT /users/relations', async () => {
		await client().listRelations({ account_id, limit: 2 })
		const path = mock.inbox().at(-1)?.path ?? ''
		expect(path).toBe('/v2/acc_1/users/me/relations?limit=2')
		expect(path).not.toBe('/v2/acc_1/users/relations?limit=2')
	})

	it('posts a LinkedIn search URL built from keywords', async () => {
		await client().searchPeople({ account_id, keywords: 'growth lead' })
		const call = mock.inbox().at(-1)
		expect(call?.method).toBe('POST')
		expect(call?.path).toBe('/v2/acc_1/linkedin/search')
		expect((call?.body as { url?: string })?.url).toBe(
			'https://www.linkedin.com/search/results/people/?keywords=growth%20lead',
		)
	})

	it('passes an explicit search url through untouched', async () => {
		const url = 'https://www.linkedin.com/search/results/people/?keywords=cto&geoUrn=1'
		await client().searchPeople({ account_id, url })
		expect((mock.inbox().at(-1)?.body as { url?: string })?.url).toBe(url)
	})

	it('fetches one profile from /users/:identifier', async () => {
		await client().getProfile({ account_id, identifier: 'janedoe' })
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/users/janedoe')
	})

	// An identifier can be a URN containing characters that would otherwise
	// change the path shape.
	it('url-encodes the identifier', async () => {
		await client().getProfile({ account_id, identifier: 'a/b?c' })
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/users/a%2Fb%3Fc')
	})
})
