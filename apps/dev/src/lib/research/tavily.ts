import {
	type ExtractFailure,
	type ExtractResult,
	type ExtractedPage,
	ResearchProviderError,
	type ResearchSearchProvider,
	type SearchHit,
	type SearchParams,
	type SearchResult,
} from './search-provider'

const TAVILY_BASE_URL = 'https://api.tavily.com'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Tavily pay-as-you-go list prices read on 2026-10-30, in micro-USD: a basic
 * search is 1 credit at $0.008, and a basic extract is 1 credit per 5 successful
 * URLs, so $0.0016 per URL. Failed URLs are not billed. Re-verify against the
 * invoice during the day-one spike (spec section 11).
 */
export const TAVILY_SEARCH_PRICE_MICRO_USD = 8_000
export const TAVILY_EXTRACT_URL_PRICE_MICRO_USD = 1_600

// Limits from the Tavily docs.
const MAX_RESULTS_LIMIT = 20
const DEFAULT_MAX_RESULTS = 10
const MAX_EXCLUDE_DOMAINS = 150
const MAX_EXTRACT_URLS = 20

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface TavilyOptions {
	apiKey: string
	/** Injected in tests. Defaults to the global fetch. */
	fetch?: FetchLike
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v)

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

const isHttpUrl = (value: string): boolean => {
	try {
		const protocol = new URL(value).protocol
		return protocol === 'http:' || protocol === 'https:'
	} catch {
		return false
	}
}

export class TavilyProvider implements ResearchSearchProvider {
	readonly name = 'tavily'
	readonly searchPriceMicroUsd = TAVILY_SEARCH_PRICE_MICRO_USD
	readonly extractUrlPriceMicroUsd = TAVILY_EXTRACT_URL_PRICE_MICRO_USD
	private readonly apiKey: string
	private readonly fetchImpl: FetchLike

	constructor(opts: TavilyOptions) {
		if (!opts.apiKey.trim()) {
			throw new ResearchProviderError('Tavily API key is empty')
		}
		this.apiKey = opts.apiKey
		this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
	}

	async search(params: SearchParams): Promise<SearchResult> {
		const query = params.query.trim()
		if (!query) throw new RangeError('search query must not be empty')
		const exclude = params.excludeDomains ?? []
		if (exclude.length > MAX_EXCLUDE_DOMAINS) {
			throw new RangeError(`at most ${MAX_EXCLUDE_DOMAINS} excluded domains per search`)
		}
		const maxResults = Math.min(
			Math.max(Math.floor(params.maxResults ?? DEFAULT_MAX_RESULTS), 1),
			MAX_RESULTS_LIMIT,
		)

		const body: Record<string, unknown> = {
			query,
			search_depth: 'basic',
			max_results: maxResults,
			include_answer: false,
			include_raw_content: false,
		}
		if (exclude.length > 0) body.exclude_domains = exclude
		if (params.boostDenmark) body.country = 'denmark'

		const json = await this.post('/search', body)
		const rawResults = isRecord(json) && Array.isArray(json.results) ? json.results : []
		const hits: SearchHit[] = []
		for (const raw of rawResults) {
			if (!isRecord(raw)) continue
			const url = asString(raw.url)
			if (!url) continue
			hits.push({
				url,
				title: asString(raw.title) ?? url,
				snippet: asString(raw.content) ?? '',
				publishedDate: asString(raw.published_date),
			})
		}
		// A search is billed whether or not it finds anything.
		return { hits, costMicroUsd: TAVILY_SEARCH_PRICE_MICRO_USD }
	}

	async extract(urls: string[]): Promise<ExtractResult> {
		const unique = [...new Set(urls)]
		if (unique.length > MAX_EXTRACT_URLS) {
			throw new RangeError(`at most ${MAX_EXTRACT_URLS} URLs per extract call`)
		}
		const failed: ExtractFailure[] = []
		const valid: string[] = []
		for (const url of unique) {
			if (isHttpUrl(url)) valid.push(url)
			else failed.push({ url, reason: 'not an http(s) URL' })
		}
		if (valid.length === 0) return { pages: [], failed, costMicroUsd: 0 }

		const json = await this.post('/extract', {
			urls: valid,
			extract_depth: 'basic',
			format: 'text',
		})
		const record = isRecord(json) ? json : {}

		const pages: ExtractedPage[] = []
		for (const raw of Array.isArray(record.results) ? record.results : []) {
			if (!isRecord(raw)) continue
			const url = asString(raw.url)
			const text = asString(raw.raw_content)
			if (url && text) pages.push({ url, text })
			else if (url) failed.push({ url, reason: 'no text returned' })
		}
		for (const raw of Array.isArray(record.failed_results) ? record.failed_results : []) {
			if (!isRecord(raw)) continue
			const url = asString(raw.url)
			if (url) failed.push({ url, reason: asString(raw.error) ?? 'could not be read' })
		}
		// Only pages that came back with text are billed.
		return { pages, failed, costMicroUsd: pages.length * TAVILY_EXTRACT_URL_PRICE_MICRO_USD }
	}

	private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
		let res: Response
		try {
			res = await this.fetchImpl(`${TAVILY_BASE_URL}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
		} catch (err) {
			const timedOut = err instanceof Error && err.name === 'TimeoutError'
			throw new ResearchProviderError(
				timedOut ? `Tavily ${path} timed out` : `Tavily ${path} request failed`,
				{ retryable: true },
			)
		}
		if (!res.ok) {
			// The response body can echo the request, so it is not copied into the error.
			const rejected = res.status === 401 || res.status === 403
			throw new ResearchProviderError(
				rejected ? 'Tavily rejected the API key' : `Tavily ${path} returned HTTP ${res.status}`,
				{ status: res.status, retryable: res.status === 429 || res.status >= 500 },
			)
		}
		try {
			return await res.json()
		} catch {
			throw new ResearchProviderError(`Tavily ${path} returned a body that is not JSON`, {
				status: res.status,
			})
		}
	}
}

/**
 * Builds the provider from the TAVILY_API_KEY env var. Throws a plain error when
 * the key is missing, so a run refuses to start instead of failing midway.
 */
export function tavilyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): TavilyProvider {
	const apiKey = env.TAVILY_API_KEY?.trim()
	if (!apiKey) {
		throw new ResearchProviderError('TAVILY_API_KEY is not set, deep_research cannot search')
	}
	return new TavilyProvider({ apiKey })
}
