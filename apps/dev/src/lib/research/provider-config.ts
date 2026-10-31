import { ResearchProviderError, type ResearchSearchProvider } from './search-provider'
import { tavilyProviderFromEnv } from './tavily'

/**
 * Picks the search provider from SEARCH_PROVIDER (spec 7.9). Only Tavily is built
 * in v1; its prices sit next to its client (tavily.ts) with their cost basis. A
 * second provider is one more case here plus its own implementation of
 * ResearchSearchProvider: the budget and run code only see the interface.
 */
export const DEFAULT_SEARCH_PROVIDER = 'tavily'

export function searchProviderFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): ResearchSearchProvider {
	const name = env.SEARCH_PROVIDER?.trim().toLowerCase() || DEFAULT_SEARCH_PROVIDER
	switch (name) {
		case 'tavily':
			return tavilyProviderFromEnv(env)
		default:
			throw new ResearchProviderError(`SEARCH_PROVIDER "${name}" is not a known search provider`)
	}
}
