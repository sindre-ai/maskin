import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import {
	brokenFirst,
	groupByCategory,
	integrationNeedsReconnect,
	isFiltered,
	matchesPill,
	matchesSearch,
	newShelf,
	popularShelf,
} from '@/lib/integration-shelves'
import { describe, expect, it } from 'vitest'

const provider = (name: string, displayName = name): ProviderInfo =>
	({ name, displayName, authType: 'oauth2', events: [] }) as unknown as ProviderInfo

describe('matchesPill', () => {
	it('matches everything for All', () => {
		expect(matchesPill('slack', 'all')).toBe(true)
	})

	it('matches a vendor pill across categories', () => {
		// Gmail is Email & calendar and Google Drive is Files; both are Google.
		expect(matchesPill('gmail', 'Google')).toBe(true)
		expect(matchesPill('google-drive', 'Google')).toBe(true)
		expect(matchesPill('microsoft', 'Google')).toBe(false)
		expect(matchesPill('microsoft', 'Microsoft')).toBe(true)
		expect(matchesPill('slack', 'Microsoft')).toBe(false)
	})

	it('matches a category pill by the tool category', () => {
		expect(matchesPill('github', 'Code')).toBe(true)
		expect(matchesPill('github', 'Files')).toBe(false)
	})
})

describe('search and filtered state', () => {
	it('matches the display name, any case, and everything when empty', () => {
		expect(matchesSearch('GitHub', 'hub')).toBe(true)
		expect(matchesSearch('GitHub', 'zzz')).toBe(false)
		expect(matchesSearch('GitHub', '')).toBe(true)
	})

	it('is filtered by a search or any pill but All', () => {
		expect(isFiltered('', 'all')).toBe(false)
		expect(isFiltered('git', 'all')).toBe(true)
		expect(isFiltered('', 'Code')).toBe(true)
		expect(isFiltered('', 'Google')).toBe(true)
	})
})

describe('popularShelf', () => {
	it('follows the editorial order and leaves out connected tools', () => {
		const available = [provider('github'), provider('gmail'), provider('slack'), provider('stripe')]
		const names = popularShelf(available, new Set(['slack'])).map((p) => p.name)
		// Gmail is featured 1, Slack 3 (connected), GitHub 4. Stripe is not featured.
		expect(names).toEqual(['gmail', 'github'])
	})

	it('is empty, so the shelf stays hidden, when no listed tool is a featured one', () => {
		expect(popularShelf([provider('stripe')], new Set())).toEqual([])
	})

	it('stops at the limit', () => {
		const available = ['gmail', 'google-calendar', 'slack', 'github'].map((n) => provider(n))
		expect(popularShelf(available, new Set(), 2)).toHaveLength(2)
	})
})

describe('newShelf', () => {
	const now = new Date('2026-11-24T12:00:00Z')

	it('keeps tools added in the last 30 days, newest first, and leaves out connected ones', () => {
		const available = [provider('zoom'), provider('box'), provider('vanta'), provider('slack')]
		const names = newShelf(available, new Set(['box']), now).map((p) => p.name)
		// Vanta 24 Nov, Zoom 20 Nov, Box 22 Nov (connected). Slack has no date.
		expect(names).toEqual(['vanta', 'zoom'])
	})

	it('is empty when nothing is inside the window', () => {
		expect(newShelf([provider('zoom')], new Set(), new Date('2027-03-01T00:00:00Z'))).toEqual([])
	})

	it('stops at the limit', () => {
		const available = ['zoom', 'box', 'vanta', 'wix'].map((n) => provider(n))
		expect(newShelf(available, new Set(), now, 3)).toHaveLength(3)
	})
})

describe('groupByCategory', () => {
	it('orders groups as the pills are ordered, keeps A to Z inside, and drops empty groups', () => {
		const groups = groupByCategory([provider('github'), provider('gmail'), provider('linear')])
		expect(groups.map((g) => g.category)).toEqual(['Email & calendar', 'Code'])
		expect(groups[1]?.providers.map((p) => p.name)).toEqual(['github', 'linear'])
	})
})

describe('brokenFirst', () => {
	const row = (over: Partial<IntegrationResponse>) => over as IntegrationResponse

	it('flags a token that lacks a scope the provider now asks for', () => {
		expect(integrationNeedsReconnect(row({ needsReconnect: true, missingScopes: ['x'] }))).toBe(
			true,
		)
		expect(integrationNeedsReconnect(row({ needsReconnect: true, missingScopes: [] }))).toBe(false)
		expect(integrationNeedsReconnect(undefined)).toBe(false)
	})

	it('moves broken tools to the top and keeps the rest in order', () => {
		const active = new Map<string, IntegrationResponse[]>([
			['linear', [row({ needsReconnect: true, missingScopes: ['x'] })]],
		])
		const ordered = brokenFirst([provider('github'), provider('gmail'), provider('linear')], active)
		expect(ordered.map((p) => p.name)).toEqual(['linear', 'github', 'gmail'])
	})
})
