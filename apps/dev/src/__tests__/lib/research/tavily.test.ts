import { describe, expect, it, vi } from 'vitest'
import { ResearchProviderError } from '../../../lib/research/search-provider'
import {
	TAVILY_EXTRACT_URL_PRICE_MICRO_USD,
	TAVILY_SEARCH_PRICE_MICRO_USD,
	TavilyProvider,
	tavilyProviderFromEnv,
} from '../../../lib/research/tavily'

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** A fetch that answers with `response` and records what it was asked. */
function fakeFetch(response: Response | (() => Response)) {
	return vi.fn(async (_url: string, _init: RequestInit) =>
		typeof response === 'function' ? response() : response,
	)
}

function sentBody(fetchMock: ReturnType<typeof fakeFetch>): Record<string, unknown> {
	return JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))
}

describe('TavilyProvider.search', () => {
	it('maps results and prices one search at $0.008', async () => {
		const fetchMock = fakeFetch(
			jsonResponse({
				results: [
					{
						title: 'Bogføringsloven',
						url: 'https://www.retsinformation.dk/eli/lta/2022/700',
						content: 'Loven gælder for ...',
						published_date: '2022-05-24',
						score: 0.9,
					},
					{ url: 'https://erst.dk/bogforing' },
					{ title: 'no url' },
					'junk',
				],
			}),
		)
		const provider = new TavilyProvider({ apiKey: 'tvly-test', fetch: fetchMock })

		const result = await provider.search({ query: 'bogføringsloven enkeltmandsvirksomhed' })

		expect(result.costMicroUsd).toBe(TAVILY_SEARCH_PRICE_MICRO_USD)
		expect(result.costMicroUsd).toBe(8_000)
		expect(result.hits).toEqual([
			{
				title: 'Bogføringsloven',
				url: 'https://www.retsinformation.dk/eli/lta/2022/700',
				snippet: 'Loven gælder for ...',
				publishedDate: '2022-05-24',
			},
			{
				title: 'https://erst.dk/bogforing',
				url: 'https://erst.dk/bogforing',
				snippet: '',
				publishedDate: null,
			},
		])
	})

	it('sends the key as a bearer token to the Tavily search endpoint', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [] }))
		await new TavilyProvider({ apiKey: 'tvly-secret', fetch: fetchMock }).search({ query: 'x' })

		const [url, init] = fetchMock.mock.calls[0] ?? []
		expect(url).toBe('https://api.tavily.com/search')
		expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tvly-secret')
	})

	it('passes excluded domains and the Denmark boost through', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [] }))
		await new TavilyProvider({ apiKey: 'k', fetch: fetchMock }).search({
			query: 'x',
			excludeDomains: ['seo-farm.example', 'listicles.example'],
			boostDenmark: true,
		})

		expect(sentBody(fetchMock)).toMatchObject({
			exclude_domains: ['seo-farm.example', 'listicles.example'],
			country: 'denmark',
			search_depth: 'basic',
		})
	})

	it('leaves the country and domain fields out when not asked for', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [] }))
		await new TavilyProvider({ apiKey: 'k', fetch: fetchMock }).search({ query: 'x' })

		const body = sentBody(fetchMock)
		expect(body).not.toHaveProperty('country')
		expect(body).not.toHaveProperty('exclude_domains')
	})

	it('still charges for a search that finds nothing', async () => {
		const result = await new TavilyProvider({
			apiKey: 'k',
			fetch: fakeFetch(jsonResponse({ results: [] })),
		}).search({ query: 'x' })
		expect(result).toEqual({ hits: [], costMicroUsd: 8_000 })
	})

	it('clamps max_results to the provider limit', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [] }))
		await new TavilyProvider({ apiKey: 'k', fetch: fetchMock }).search({
			query: 'x',
			maxResults: 500,
		})
		expect(sentBody(fetchMock).max_results).toBe(20)
	})

	it('rejects an empty query and more than 150 excluded domains before calling out', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [] }))
		const provider = new TavilyProvider({ apiKey: 'k', fetch: fetchMock })

		await expect(provider.search({ query: '   ' })).rejects.toBeInstanceOf(RangeError)
		await expect(
			provider.search({
				query: 'x',
				excludeDomains: Array.from({ length: 151 }, (_, i) => `d${i}.example`),
			}),
		).rejects.toBeInstanceOf(RangeError)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('TavilyProvider.extract', () => {
	it('returns page text, lists unreadable URLs and bills only the pages read', async () => {
		const fetchMock = fakeFetch(
			jsonResponse({
				results: [
					{ url: 'https://a.example/1', raw_content: 'Page one text' },
					{ url: 'https://a.example/empty', raw_content: '' },
				],
				failed_results: [{ url: 'https://a.example/paywalled', error: 'blocked' }],
			}),
		)
		const result = await new TavilyProvider({ apiKey: 'k', fetch: fetchMock }).extract([
			'https://a.example/1',
			'https://a.example/empty',
			'https://a.example/paywalled',
		])

		expect(result.pages).toEqual([{ url: 'https://a.example/1', text: 'Page one text' }])
		expect(result.failed).toEqual([
			{ url: 'https://a.example/empty', reason: 'no text returned' },
			{ url: 'https://a.example/paywalled', reason: 'blocked' },
		])
		expect(result.costMicroUsd).toBe(TAVILY_EXTRACT_URL_PRICE_MICRO_USD)
		expect(result.costMicroUsd).toBe(1_600)
	})

	it('calls only the Tavily extract endpoint and sends each URL once', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [], failed_results: [] }))
		await new TavilyProvider({ apiKey: 'k', fetch: fetchMock }).extract([
			'https://a.example/1',
			'https://a.example/1',
		])

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.tavily.com/extract')
		expect(sentBody(fetchMock).urls).toEqual(['https://a.example/1'])
	})

	it('does not send non-http URLs and makes no call when none are left', async () => {
		const fetchMock = fakeFetch(jsonResponse({ results: [] }))
		const result = await new TavilyProvider({ apiKey: 'k', fetch: fetchMock }).extract([
			'file:///etc/passwd',
			'not a url',
			'http://169.254.169.254/latest/meta-data',
		])

		// Private addresses are the provider's to refuse; the API process never connects to them.
		expect(sentBody(fetchMock).urls).toEqual(['http://169.254.169.254/latest/meta-data'])
		expect(result.failed.map((f) => f.url)).toEqual(['file:///etc/passwd', 'not a url'])

		const none = fakeFetch(jsonResponse({}))
		const empty = await new TavilyProvider({ apiKey: 'k', fetch: none }).extract(['ftp://x'])
		expect(none).not.toHaveBeenCalled()
		expect(empty).toEqual({
			pages: [],
			failed: [{ url: 'ftp://x', reason: 'not an http(s) URL' }],
			costMicroUsd: 0,
		})
	})

	it('rejects more than 20 URLs in one call', async () => {
		const provider = new TavilyProvider({ apiKey: 'k', fetch: fakeFetch(jsonResponse({})) })
		const urls = Array.from({ length: 21 }, (_, i) => `https://a.example/${i}`)
		await expect(provider.extract(urls)).rejects.toBeInstanceOf(RangeError)
	})
})

describe('TavilyProvider errors', () => {
	const search = (response: Response) =>
		new TavilyProvider({ apiKey: 'tvly-secret', fetch: fakeFetch(response) }).search({ query: 'x' })

	it('says the key was rejected on 401 without echoing the key or the body', async () => {
		const err = await search(jsonResponse({ detail: 'bad key tvly-secret' }, 401)).catch((e) => e)
		expect(err).toBeInstanceOf(ResearchProviderError)
		expect(err.status).toBe(401)
		expect(err.retryable).toBe(false)
		expect(err.message).toBe('Tavily rejected the API key')
		expect(err.message).not.toContain('tvly-secret')
	})

	it('marks rate limits and server errors as retryable', async () => {
		const rateLimited = await search(jsonResponse({}, 429)).catch((e) => e)
		const down = await search(jsonResponse({}, 503)).catch((e) => e)
		expect(rateLimited.retryable).toBe(true)
		expect(down.retryable).toBe(true)
	})

	it('treats other client errors as not retryable', async () => {
		const err = await search(jsonResponse({}, 400)).catch((e) => e)
		expect(err.status).toBe(400)
		expect(err.retryable).toBe(false)
	})

	it('wraps a network failure as a retryable provider error', async () => {
		const provider = new TavilyProvider({
			apiKey: 'k',
			fetch: async () => {
				throw new TypeError('fetch failed')
			},
		})
		const err = await provider.search({ query: 'x' }).catch((e) => e)
		expect(err).toBeInstanceOf(ResearchProviderError)
		expect(err.retryable).toBe(true)
	})

	it('wraps a non-JSON body as a provider error', async () => {
		const err = await search(new Response('<html>oops</html>', { status: 200 })).catch((e) => e)
		expect(err).toBeInstanceOf(ResearchProviderError)
	})
})

describe('tavilyProviderFromEnv', () => {
	it('builds a provider from TAVILY_API_KEY', () => {
		expect(tavilyProviderFromEnv({ TAVILY_API_KEY: 'tvly-x' }).name).toBe('tavily')
	})

	it('refuses to start when the key is missing or blank', () => {
		expect(() => tavilyProviderFromEnv({})).toThrow(ResearchProviderError)
		expect(() => tavilyProviderFromEnv({ TAVILY_API_KEY: '  ' })).toThrow(/TAVILY_API_KEY/)
	})
})
