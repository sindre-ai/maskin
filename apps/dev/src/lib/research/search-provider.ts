/**
 * The one seam between a deep_research run and the web. The run code talks to
 * this interface only, so switching from Tavily to another provider (for
 * example Anthropic's web tools) means writing a second implementation, not
 * touching the run.
 *
 * Fetching pages goes through `extract` on the provider's side. The API process
 * never opens a connection to an arbitrary host, which is what keeps it clear of
 * SSRF (internal addresses, the metadata endpoint, redirects).
 *
 * Costs are in micro-USD (1 USD = 1_000_000) because the provider's flat prices
 * are fractions of a cent. The budget object adds them up and rounds to cents at
 * the end.
 */

export interface SearchParams {
	query: string
	/** Defaults to the provider's own default when unset. */
	maxResults?: number
	/** Domains whose pages must not come back (the source-quality denylist). */
	excludeDomains?: string[]
	/** Boost results from Denmark. Maskin's real research questions are Danish. */
	boostDenmark?: boolean
}

export interface SearchHit {
	title: string
	url: string
	/** The provider's short excerpt. Not the page text, so never quote-checked. */
	snippet: string
	/** As the provider reports it, or null when it reports none. */
	publishedDate: string | null
}

export interface SearchResult {
	hits: SearchHit[]
	costMicroUsd: number
}

export interface ExtractedPage {
	url: string
	text: string
}

export interface ExtractFailure {
	url: string
	reason: string
}

export interface ExtractResult {
	pages: ExtractedPage[]
	/** Pages the provider could not read. Reported as unread, never as "nothing found". */
	failed: ExtractFailure[]
	costMicroUsd: number
}

export interface ResearchSearchProvider {
	readonly name: string
	search(params: SearchParams): Promise<SearchResult>
	extract(urls: string[]): Promise<ExtractResult>
}

/** The provider call failed or no provider is configured. Never carries the API key. */
export class ResearchProviderError extends Error {
	readonly status: number | null
	/** True for rate limits, timeouts and 5xx: the same call may work later. */
	readonly retryable: boolean

	constructor(message: string, opts: { status?: number | null; retryable?: boolean } = {}) {
		super(message)
		this.name = 'ResearchProviderError'
		this.status = opts.status ?? null
		this.retryable = opts.retryable ?? false
	}
}
