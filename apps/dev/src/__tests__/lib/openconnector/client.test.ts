import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listProviders, resolveOpenConnectorConfig } from '../../../lib/openconnector/client'

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response
}

const PROVIDER = {
	id: 'stripe',
	name: 'Stripe',
	category: 'Payments',
	iconUrl: 'https://cdn.example/stripe.svg',
	description: 'Accept payments',
	actionCount: 12,
}

describe('resolveOpenConnectorConfig', () => {
	it('returns null when either variable is unset', () => {
		expect(resolveOpenConnectorConfig({ OPENCONNECTOR_RUNTIME_TOKEN: 't' })).toBeNull()
		expect(resolveOpenConnectorConfig({ OPENCONNECTOR_RUNTIME_URL: 'http://x' })).toBeNull()
		expect(resolveOpenConnectorConfig({})).toBeNull()
	})

	it('treats whitespace-only values as unset', () => {
		expect(
			resolveOpenConnectorConfig({
				OPENCONNECTOR_RUNTIME_URL: '   ',
				OPENCONNECTOR_RUNTIME_TOKEN: 't',
			}),
		).toBeNull()
	})

	it('strips trailing slashes from the base URL', () => {
		expect(
			resolveOpenConnectorConfig({
				OPENCONNECTOR_RUNTIME_URL: 'http://localhost:9000///',
				OPENCONNECTOR_RUNTIME_TOKEN: 't',
			}),
		).toEqual({ baseUrl: 'http://localhost:9000', token: 't' })
	})
})

describe('listProviders', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	const config = { baseUrl: 'http://localhost:9000', token: 'tok' }

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(jsonResponse([PROVIDER]))
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('skips the fetch entirely when the runtime is not configured', async () => {
		expect(await listProviders(null, fetchMock as unknown as typeof fetch)).toBeNull()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('requests /v1/providers with a bearer token', async () => {
		await listProviders(config, fetchMock as unknown as typeof fetch)
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('http://localhost:9000/v1/providers')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
	})

	it('maps the response onto the fields the card renders', async () => {
		const result = await listProviders(config, fetchMock as unknown as typeof fetch)
		expect(result).toEqual([
			{
				id: 'stripe',
				name: 'Stripe',
				category: 'Payments',
				iconUrl: 'https://cdn.example/stripe.svg',
				description: 'Accept payments',
				actionCount: 12,
			},
		])
	})

	it.each([
		['bare array', [PROVIDER]],
		['providers envelope', { providers: [PROVIDER] }],
		['data envelope', { data: [PROVIDER] }],
	])('accepts a %s response shape', async (_label, body) => {
		fetchMock.mockResolvedValueOnce(jsonResponse(body))
		const result = await listProviders(config, fetchMock as unknown as typeof fetch)
		expect(result).toHaveLength(1)
		expect(result?.[0]?.id).toBe('stripe')
	})

	it('defaults optional fields rather than dropping the provider', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'notion', name: 'Notion' }]))
		const result = await listProviders(config, fetchMock as unknown as typeof fetch)
		expect(result).toEqual([
			{
				id: 'notion',
				name: 'Notion',
				category: null,
				iconUrl: null,
				description: null,
				actionCount: 0,
			},
		])
	})

	it('keeps providers that carry unknown extra fields', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([{ ...PROVIDER, somethingNew: true }]))
		const result = await listProviders(config, fetchMock as unknown as typeof fetch)
		expect(result).toHaveLength(1)
	})

	it('returns null on a non-2xx response', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 503))
		expect(await listProviders(config, fetchMock as unknown as typeof fetch)).toBeNull()
	})

	it('returns null instead of throwing when the runtime is unreachable', async () => {
		fetchMock.mockRejectedValueOnce(new Error('fetch failed'))
		await expect(listProviders(config, fetchMock as unknown as typeof fetch)).resolves.toBeNull()
	})

	it('returns null when the payload fails schema validation', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: 'shape' }))
		expect(await listProviders(config, fetchMock as unknown as typeof fetch)).toBeNull()
	})

	it('distinguishes an empty catalog from an unavailable one', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([]))
		expect(await listProviders(config, fetchMock as unknown as typeof fetch)).toEqual([])
	})
})
