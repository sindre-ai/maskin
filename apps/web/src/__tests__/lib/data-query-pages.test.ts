import { readEveryPage } from '@/lib/data-query-pages'
import type { DataQueryResult } from '@maskin/shared'
import { describe, expect, it, vi } from 'vitest'

function page(keys: string[], next: string | null, total = 5): DataQueryResult {
	return {
		groups: keys.map((key) => ({ key, count: 1, value: 1 })),
		total: { count: total, value: total },
		next_cursor: next,
		rows_truncated: false,
		groups_truncated: next !== null,
	}
}

/** A server that hands out `pages` in order, keyed by the cursor each page points at. */
function server(pages: DataQueryResult[][]) {
	let attempt = 0
	return vi.fn(async (cursor: string | null) => {
		if (cursor === null) attempt = Math.min(attempt + 1, pages.length) // each restart is a new read
		const read = pages[attempt - 1]
		const index = cursor === null ? 0 : Number(cursor.replace('c', ''))
		return read[index]
	})
}

describe('readEveryPage', () => {
	it('returns a single page as it is, with no cursor', async () => {
		const read = server([[page(['a', 'b'], null)]])
		const result = await readEveryPage(read)
		expect(result.groups.map((g) => g.key)).toEqual(['a', 'b'])
		expect(result.next_cursor).toBeNull()
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('follows the cursors and merges every group in order', async () => {
		const read = server([[page(['a', 'b'], 'c1'), page(['c', 'd'], 'c2'), page(['e'], null)]])
		const result = await readEveryPage(read)
		expect(result.groups.map((g) => g.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
		expect(result.next_cursor).toBeNull()
		expect(result.groups_truncated).toBe(false)
		expect(result.rows_truncated).toBe(false)
		expect(result.total.count).toBe(5)
		expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'c1', 'c2'])
	})

	it('reads again from the start when a later page no longer matches the first', async () => {
		const read = server([
			// The snapshot expired and the server recomputed: the totals moved.
			[page(['a', 'b'], 'c1', 4), page(['x'], null, 5)],
			[page(['a', 'b'], 'c1', 5), page(['c'], null, 5)],
		])
		const result = await readEveryPage(read)
		expect(result.groups.map((g) => g.key)).toEqual(['a', 'b', 'c'])
		expect(result.total.count).toBe(5)
	})

	it('takes what it has after a couple of restarts instead of failing the view', async () => {
		const drifting = [page(['a'], 'c1', 1), page(['b'], null, 2)]
		const read = server([drifting, drifting, drifting])
		const result = await readEveryPage(read)
		expect(result.groups.map((g) => g.key)).toEqual(['a', 'b'])
		expect(read.mock.calls.filter(([cursor]) => cursor === null)).toHaveLength(3)
	})

	it('copes with a server that sends no cursor field at all', async () => {
		const old = { ...page(['a'], null), next_cursor: undefined } as unknown as DataQueryResult
		const result = await readEveryPage(async () => old)
		expect(result.groups).toHaveLength(1)
		expect(result.next_cursor).toBeNull()
	})

	it('passes a failed page up so the view can show the error', async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(page(['a'], 'c1'))
			.mockRejectedValueOnce(new Error('Database query got no response'))
		await expect(readEveryPage(read)).rejects.toThrow('no response')
	})
})
