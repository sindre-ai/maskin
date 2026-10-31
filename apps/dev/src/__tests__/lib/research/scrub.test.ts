import { describe, expect, it, vi } from 'vitest'
import {
	QueryRejectedError,
	SCRUB_REJECTION_MESSAGE,
	createQueryScrub,
	normalizeForScrub,
	withQueryScrub,
} from '../../../lib/research/scrub'
import type { ResearchSearchProvider } from '../../../lib/research/search-provider'

function fakeProvider() {
	return {
		name: 'fake',
		searchPriceMicroUsd: 8_000,
		extractUrlPriceMicroUsd: 1_600,
		search: vi.fn(async () => ({ hits: [], costMicroUsd: 8_000 })),
		extract: vi.fn(async () => ({ pages: [], failed: [], costMicroUsd: 0 })),
	} satisfies ResearchSearchProvider
}

const scrubbed = (names: string[]) => {
	const provider = fakeProvider()
	return { provider, search: withQueryScrub(provider, createQueryScrub(names)) }
}

describe('normalizeForScrub', () => {
	it('folds case, diacritics, punctuation and spacing', () => {
		expect(normalizeForScrub('  Café-Müller,  A/S ')).toBe('cafe muller a s')
	})

	it('folds Danish letters the way a person would type them without the keys', () => {
		expect(normalizeForScrub('Bogføring')).toBe(normalizeForScrub('bogfoering'))
		expect(normalizeForScrub('Århus')).toBe(normalizeForScrub('aarhus'))
		expect(normalizeForScrub('Ærø')).toBe(normalizeForScrub('aeroe'))
	})
})

describe('the query scrub', () => {
	it('rejects a query with a workspace object title and never calls the provider', async () => {
		const { provider, search } = scrubbed(['Hansen Tømrer renovation'])
		await expect(
			search.search({ query: 'priser Hansen Tømrer renovation 2026' }),
		).rejects.toBeInstanceOf(QueryRejectedError)
		expect(provider.search).toHaveBeenCalledTimes(0)
	})

	it('rejects a contact name and a company name the same way', async () => {
		// Contacts and companies are workspace objects, so their names arrive as titles.
		const { provider, search } = scrubbed(['Mette Sørensen', 'Nordbyg Holding'])
		await expect(search.search({ query: 'who is Mette Sørensen' })).rejects.toBeInstanceOf(
			QueryRejectedError,
		)
		await expect(search.search({ query: 'Nordbyg Holding annual report' })).rejects.toBeInstanceOf(
			QueryRejectedError,
		)
		expect(provider.search).toHaveBeenCalledTimes(0)
	})

	it.each([
		['upper case', 'HANSEN TØMRER'],
		['Danish letters spelled out', 'hansen toemrer'],
		['extra spaces and punctuation', 'hansen,   tømrer!'],
		['hyphen for space', 'Hansen-Tømrer'],
	])('rejects a variant of a title: %s', async (_label, query) => {
		const { provider, search } = scrubbed(['Hansen Tømrer'])
		await expect(search.search({ query: `news about ${query} today` })).rejects.toBeInstanceOf(
			QueryRejectedError,
		)
		expect(provider.search).toHaveBeenCalledTimes(0)
	})

	it('rejects a title written without its diacritics', async () => {
		const { provider, search } = scrubbed(['Café Müller'])
		await expect(search.search({ query: 'cafe muller opening hours' })).rejects.toBeInstanceOf(
			QueryRejectedError,
		)
		expect(provider.search).toHaveBeenCalledTimes(0)
	})

	it('lets a public-topic query through and calls the provider once', async () => {
		const { provider, search } = scrubbed(['Hansen Tømrer', 'Nordbyg Holding'])
		const result = await search.search({
			query: 'bogføringsloven opbevaring af regnskabsmateriale',
		})
		expect(result.costMicroUsd).toBe(8_000)
		expect(provider.search).toHaveBeenCalledTimes(1)
	})

	it('matches whole phrases only, not a name inside a longer word', async () => {
		const { provider, search } = scrubbed(['Acme'])
		await search.search({ query: 'acmeist philosophy' })
		expect(provider.search).toHaveBeenCalledTimes(1)
	})

	it('ignores names under 4 characters', async () => {
		const { provider, search } = scrubbed(['AB', 'Jo', 'IBM'])
		await search.search({ query: 'IBM AB Jo history' })
		expect(provider.search).toHaveBeenCalledTimes(1)
	})

	it('does nothing with an empty name list', async () => {
		const { provider, search } = scrubbed([])
		await search.search({ query: 'anything at all' })
		expect(provider.search).toHaveBeenCalledTimes(1)
	})

	it('never puts the matched name in the error', async () => {
		const { search } = scrubbed(['Hansen Tømrer'])
		const err = await search.search({ query: 'Hansen Tømrer' }).catch((e) => e)
		expect(err).toBeInstanceOf(QueryRejectedError)
		expect(err.message).toBe(SCRUB_REJECTION_MESSAGE)
		expect(err.message.toLowerCase()).not.toContain('hansen')
	})

	it('does not scrub extract: it sends URLs the provider returned, not query text', async () => {
		const { provider, search } = scrubbed(['Hansen Tømrer'])
		await search.extract(['https://example.com/hansen-tomrer'])
		expect(provider.extract).toHaveBeenCalledTimes(1)
	})

	it('keeps the provider name and prices so the budget sees the real ones', () => {
		const { provider, search } = scrubbed([])
		expect(search.name).toBe(provider.name)
		expect(search.searchPriceMicroUsd).toBe(8_000)
		expect(search.extractUrlPriceMicroUsd).toBe(1_600)
	})

	it('stays quick with thousands of titles', () => {
		const names = Array.from({ length: 20_000 }, (_, i) => `Customer number ${i} Ltd`)
		const scrub = createQueryScrub(names)
		const start = Date.now()
		for (let i = 0; i < 200; i++)
			scrub.containsName('what is the vat rate for restaurants in denmark')
		expect(Date.now() - start).toBeLessThan(1_000)
		expect(scrub.containsName('details on customer number 19999 ltd please')).toBe(true)
	})
})
