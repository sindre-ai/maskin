import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackSearchPerformed: vi.fn(),
	trackSearchResultOpened: vi.fn(),
}))

import { trackSearchPerformed, trackSearchResultOpened } from '@/lib/analytics'
import {
	type SettledSearchV2Input,
	trackSearchRowOpened,
	useTrackSettledSearchV2,
} from '@/lib/search-telemetry'

const settled: SettledSearchV2Input = {
	active: true,
	query: 'hans acme',
	types: ['loop', 'agent'],
	statuses: ['done'],
	updated: 'week',
	sort: 'rel',
	entry: 'typed',
	isSettled: true,
	isPartial: false,
	total: 4,
}

beforeEach(() => {
	vi.mocked(trackSearchPerformed).mockClear()
	vi.mocked(trackSearchResultOpened).mockClear()
})

describe('useTrackSettledSearchV2 — search_performed', () => {
	it('keeps the frozen fields and adds the v2 ones, with no query text', () => {
		renderHook(() => useTrackSettledSearchV2(settled))

		expect(trackSearchPerformed).toHaveBeenCalledTimes(1)
		const payload = vi.mocked(trackSearchPerformed).mock.calls[0]?.[0]
		expect(payload).toEqual({
			surface: 'search_view',
			search_id: expect.any(String),
			result_count: 4,
			is_partial: false,
			query_length: 'hans acme'.length,
			words_count: 2,
			type_filter: 'agent,loop',
			status_filter: 'done',
			ui_version: 'v2',
			entry: 'typed',
			pill_count: 3,
			filter_count: 3,
			sort: 'rel',
		})
		expect(JSON.stringify(payload)).not.toContain('hans')
	})

	it('fires once per settled search and not while loading or for placeholder data', () => {
		const { rerender } = renderHook((props) => useTrackSettledSearchV2(props), {
			initialProps: { ...settled, isSettled: false },
		})
		expect(trackSearchPerformed).not.toHaveBeenCalled()

		rerender({ ...settled })
		rerender({ ...settled })
		expect(trackSearchPerformed).toHaveBeenCalledTimes(1)
	})

	it('does not fire for a filter-only search with no words', () => {
		renderHook(() => useTrackSettledSearchV2({ ...settled, query: '  ' }))
		expect(trackSearchPerformed).not.toHaveBeenCalled()
	})

	it('treats a new filter as a new search but a sort change as the same search', () => {
		const { rerender } = renderHook((props) => useTrackSettledSearchV2(props), {
			initialProps: settled,
		})
		rerender({ ...settled, sort: 'recent' })
		expect(trackSearchPerformed).toHaveBeenCalledTimes(1)

		rerender({ ...settled, sort: 'recent', statuses: [] })
		expect(trackSearchPerformed).toHaveBeenCalledTimes(2)
		expect(vi.mocked(trackSearchPerformed).mock.calls[1]?.[0]).toMatchObject({
			status_filter: null,
			pill_count: 2,
			sort: 'recent',
		})
	})

	it('sends no type filter when none is chosen', () => {
		renderHook(() => useTrackSettledSearchV2({ ...settled, types: [], statuses: [], updated: '' }))
		expect(vi.mocked(trackSearchPerformed).mock.calls[0]?.[0]).toMatchObject({
			type_filter: null,
			status_filter: null,
			pill_count: 0,
			filter_count: 0,
		})
	})
})

describe('trackSearchRowOpened — ui_version', () => {
	const row = {
		surface: 'search_view' as const,
		entityId: 'a1',
		entityType: 'agent' as const,
		group: 'agents' as const,
		position: 1,
		listSize: 3,
	}

	it('ties an open to the v2 search and marks it v2', () => {
		renderHook(() => useTrackSettledSearchV2(settled))
		const searchId = vi.mocked(trackSearchPerformed).mock.calls[0]?.[0].search_id

		trackSearchRowOpened({ ...row, hasQuery: true, uiVersion: 'v2' })

		expect(trackSearchResultOpened).toHaveBeenCalledWith({
			entity_id: 'a1',
			entity_type: 'agent',
			surface: 'search_view',
			search_id: searchId,
			has_query: true,
			result_count: 4,
			position: 1,
			result_group: 'agents',
			ui_version: 'v2',
		})
	})

	it('leaves the legacy payload exactly as it was', () => {
		trackSearchRowOpened({ ...row, hasQuery: false })
		const payload = vi.mocked(trackSearchResultOpened).mock.calls[0]?.[0]
		expect(payload).not.toHaveProperty('ui_version')
	})
})
