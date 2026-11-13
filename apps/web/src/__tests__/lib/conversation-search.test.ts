import { type LoadedList, hitLine, isArchivedHit } from '@/lib/conversation-search'
import type { SearchResultRow } from '@maskin/shared'
import { describe, expect, it } from 'vitest'

function hit(overrides: Partial<SearchResultRow> = {}): SearchResultRow {
	return {
		id: 'chat-1',
		group: 'chats',
		type: 'chat',
		title: 'Billing retries',
		sub: 'Developer, Me',
		snippet: null,
		status: 'read',
		statusGroup: 'done',
		updatedAt: '2026-11-01T10:00:00.000Z',
		...overrides,
	}
}

const list = (overrides: Partial<LoadedList> = {}): LoadedList => ({
	ids: new Set(['other']),
	hasMore: false,
	oldestActivityAt: new Date('2026-10-20T00:00:00.000Z').getTime(),
	...overrides,
})

describe('isArchivedHit', () => {
	it('marks a chat the person archived', () => {
		expect(isArchivedHit(hit({ status: 'archived' }), null)).toBe(true)
	})

	it('does not mark an ordinary chat when no list is compared', () => {
		expect(isArchivedHit(hit(), null)).toBe(false)
	})

	it('does not mark a chat the list holds', () => {
		expect(isArchivedHit(hit(), list({ ids: new Set(['chat-1']) }))).toBe(false)
	})

	it('marks a chat missing from a fully loaded list', () => {
		expect(isArchivedHit(hit(), list())).toBe(true)
	})

	it('marks a missing chat newer than the oldest loaded row while pages remain', () => {
		expect(isArchivedHit(hit(), list({ hasMore: true }))).toBe(true)
	})

	it('leaves a missing chat older than the oldest loaded row alone while pages remain', () => {
		const old = hit({ updatedAt: '2026-09-01T00:00:00.000Z' })
		expect(isArchivedHit(old, list({ hasMore: true }))).toBe(false)
	})

	it('cannot tell when pages remain and the hit has no activity time', () => {
		expect(isArchivedHit(hit({ updatedAt: null }), list({ hasMore: true }))).toBe(false)
	})
})

describe('hitLine', () => {
	it('shows the matching message', () => {
		expect(hitLine(hit({ snippet: 'retries run at noon' }), 'noon')).toBe('retries run at noon')
	})

	it('shows the people when the name matched and the message did not', () => {
		expect(hitLine(hit({ snippet: 'retries run at noon' }), 'developer')).toBe('Developer, Me')
	})

	it('falls back to the people when there is no message', () => {
		expect(hitLine(hit(), 'billing')).toBe('Developer, Me')
	})

	it('is empty when the row has neither', () => {
		expect(hitLine(hit({ sub: null }), 'billing')).toBeNull()
	})
})
