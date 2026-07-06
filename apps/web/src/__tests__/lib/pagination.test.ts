import { DEFAULT_PAGE_SIZE, fetchAllPages } from '@/lib/pagination'
import { describe, expect, it, vi } from 'vitest'

describe('fetchAllPages', () => {
	it('returns an empty list when the first page is empty', async () => {
		const fetchPage = vi.fn().mockResolvedValue([])
		const result = await fetchAllPages<number>(fetchPage, 100)
		expect(result).toEqual([])
		expect(fetchPage).toHaveBeenCalledTimes(1)
		expect(fetchPage).toHaveBeenCalledWith({ limit: 100, offset: 0 })
	})

	it('stops after a single short page', async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce([1, 2, 3])
		const result = await fetchAllPages<number>(fetchPage, 100)
		expect(result).toEqual([1, 2, 3])
		expect(fetchPage).toHaveBeenCalledTimes(1)
	})

	it('pages until a short page arrives, advancing offset by the returned length', async () => {
		const pageSize = 4
		const pages = [
			[1, 2, 3, 4],
			[5, 6, 7, 8],
			[9, 10],
		]
		const fetchPage = vi.fn().mockImplementation(async () => pages.shift() ?? [])
		const result = await fetchAllPages<number>(fetchPage, pageSize)
		expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		expect(fetchPage).toHaveBeenCalledTimes(3)
		expect(fetchPage).toHaveBeenNthCalledWith(1, { limit: pageSize, offset: 0 })
		expect(fetchPage).toHaveBeenNthCalledWith(2, { limit: pageSize, offset: pageSize })
		expect(fetchPage).toHaveBeenNthCalledWith(3, { limit: pageSize, offset: pageSize * 2 })
	})

	it('makes a follow-up request when the first page is exactly full', async () => {
		const pageSize = 2
		const pages = [[1, 2], [3, 4], []]
		const fetchPage = vi.fn().mockImplementation(async () => pages.shift() ?? [])
		const result = await fetchAllPages<number>(fetchPage, pageSize)
		expect(result).toEqual([1, 2, 3, 4])
		expect(fetchPage).toHaveBeenCalledTimes(3)
	})

	it('defaults to 100 per page (matches the server-side max)', async () => {
		const fetchPage = vi.fn().mockResolvedValue([])
		await fetchAllPages<number>(fetchPage)
		expect(fetchPage).toHaveBeenCalledWith({ limit: DEFAULT_PAGE_SIZE, offset: 0 })
		expect(DEFAULT_PAGE_SIZE).toBe(100)
	})
})
