import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

vi.mock('@/lib/api', () => ({
	api: { search: { query: vi.fn() } },
}))

import {
	buildSearchParams,
	hasSearchInput,
	useDebouncedValue,
	useSearchQuery,
} from '@/hooks/use-search-query'
import { api } from '@/lib/api'

const base = { text: '', types: [], statuses: [], updated: '' as const, sort: 'rel' as const }

const response = {
	results: [],
	total: 0,
	capped: false,
	facets: {
		types: {},
		statuses: { needs_you: 0, in_progress: 0, new: 0, done: 0, archived: 0 },
	},
	relaxed: { withoutFilters: 0, withoutStatuses: 0 },
	partial: [],
}

describe('buildSearchParams', () => {
	it('sends only what is set', () => {
		expect(buildSearchParams(base)).toEqual({})
		expect(
			buildSearchParams({
				text: ' hans ',
				types: ['loop', 'agent'],
				statuses: ['done'],
				updated: '',
				sort: 'recent',
			}),
		).toEqual({ q: 'hans', types: 'loop,agent', statuses: 'done', sort: 'recent' })
	})

	it('turns an Updated window into a cutoff from the clock', () => {
		const now = Date.parse('2026-10-26T12:00:00.000Z')
		expect(buildSearchParams({ ...base, updated: 'day' }, now).updated_after).toBe(
			'2026-10-25T12:00:00.000Z',
		)
		expect(buildSearchParams({ ...base, updated: 'week' }, now).updated_after).toBe(
			'2026-10-19T12:00:00.000Z',
		)
		expect(buildSearchParams({ ...base, updated: 'month' }, now).updated_after).toBe(
			'2026-09-26T12:00:00.000Z',
		)
	})
})

describe('participants', () => {
	it('are sent as a comma list and count as something to ask', () => {
		expect(buildSearchParams({ ...base, participants: ['a1', 'b2'] })).toEqual({
			participants: 'a1,b2',
		})
		expect(buildSearchParams({ ...base, participants: [] })).toEqual({})
		expect(hasSearchInput({ ...base, participants: ['a1'] })).toBe(true)
	})
})

describe('hasSearchInput', () => {
	it('needs words or a filter, and a sort alone is not enough', () => {
		expect(hasSearchInput(base)).toBe(false)
		expect(hasSearchInput({ ...base, sort: 'az' })).toBe(false)
		expect(hasSearchInput({ ...base, text: 'x' })).toBe(true)
		expect(hasSearchInput({ ...base, types: ['loop'] })).toBe(true)
		expect(hasSearchInput({ ...base, statuses: ['done'] })).toBe(true)
		expect(hasSearchInput({ ...base, updated: 'day' })).toBe(true)
	})
})

describe('useSearchQuery', () => {
	beforeEach(() => {
		vi.mocked(api.search.query).mockReset()
		vi.mocked(api.search.query).mockResolvedValue(response)
	})

	it('does not call the endpoint with nothing to search for', () => {
		renderHook(() => useSearchQuery('ws-1', base), { wrapper: TestWrapper })
		expect(api.search.query).not.toHaveBeenCalled()
	})

	it('calls the endpoint with the params and an abort signal', async () => {
		const { result } = renderHook(
			() => useSearchQuery('ws-1', { ...base, text: 'hans', types: ['loop'] }),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.search.query).toHaveBeenCalledWith(
			'ws-1',
			{ q: 'hans', types: 'loop' },
			{ signal: expect.any(AbortSignal) },
		)
	})

	it('keeps the previous answer on screen while the next one loads', async () => {
		let release: (value: typeof response) => void = () => {}
		vi.mocked(api.search.query).mockResolvedValueOnce({ ...response, total: 5 })
		vi.mocked(api.search.query).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const { result, rerender } = renderHook(
			({ text }) => useSearchQuery('ws-1', { ...base, text }),
			{ wrapper: TestWrapper, initialProps: { text: 'han' } },
		)
		await waitFor(() => expect(result.current.data?.total).toBe(5))

		rerender({ text: 'hans' })
		await waitFor(() => expect(result.current.isFetching).toBe(true))
		expect(result.current.data?.total).toBe(5)
		expect(result.current.isPlaceholderData).toBe(true)

		await act(async () => release({ ...response, total: 2 }))
		await waitFor(() => expect(result.current.data?.total).toBe(2))
	})
})

describe('useDebouncedValue', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('waits for the value to rest before passing it on', () => {
		const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
			initialProps: { v: 'a' },
		})
		rerender({ v: 'ab' })
		act(() => vi.advanceTimersByTime(200))
		rerender({ v: 'abc' })
		act(() => vi.advanceTimersByTime(200))
		expect(result.current).toBe('a')
		act(() => vi.advanceTimersByTime(60))
		expect(result.current).toBe('abc')
	})
})
