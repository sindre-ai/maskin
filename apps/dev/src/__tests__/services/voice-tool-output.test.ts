import { describe, expect, it } from 'vitest'
import { capToolOutput } from '../../services/voice-tool-output'

const MAX = 20_000

function rowsOf(count: number, size = 400) {
	return Array.from({ length: count }, (_, i) => ({
		id: `row-${i}`,
		provider: i === 91 ? 'slack' : 'google-meet',
		note: 'x'.repeat(size),
	}))
}

describe('capToolOutput', () => {
	it('returns a result that fits unchanged', () => {
		const text = JSON.stringify({ integrations: rowsOf(3) })
		expect(capToolOutput(text, MAX)).toBe(text)
	})

	it('drops whole rows from the tail and stays valid JSON', () => {
		const text = JSON.stringify({ integrations: rowsOf(100) })
		const out = capToolOutput(text, MAX)

		expect(out.length).toBeLessThanOrEqual(MAX)
		const parsed = JSON.parse(out) as { integrations: Array<{ id: string }> }
		expect(parsed.integrations.length).toBeGreaterThan(0)
		expect(parsed.integrations.length).toBeLessThan(100)
		// The rows that remain are the leading ones, untouched.
		expect(parsed.integrations.map((r) => r.id)).toEqual(
			rowsOf(parsed.integrations.length).map((r) => r.id),
		)
	})

	it('says how many rows were left out and what to do, ahead of the rows', () => {
		const text = JSON.stringify({ integrations: rowsOf(100) })
		const out = capToolOutput(text, MAX)
		const parsed = JSON.parse(out) as {
			voice_truncated: { omitted: number; shown: number; of: number; note: string }
			integrations: unknown[]
		}

		expect(parsed.voice_truncated.of).toBe(100)
		expect(parsed.voice_truncated.shown).toBe(parsed.integrations.length)
		expect(parsed.voice_truncated.omitted).toBe(100 - parsed.integrations.length)
		expect(parsed.voice_truncated.note).toContain('incomplete')
		expect(out.indexOf('voice_truncated')).toBeLessThan(out.indexOf('"integrations"'))
	})

	it('tells a page block it is no longer the last page and counts the rows that shipped', () => {
		const text = JSON.stringify({
			page: { limit: 100, returned: 100, total: 100, has_more: false },
			integrations: rowsOf(100),
		})
		const parsed = JSON.parse(capToolOutput(text, MAX)) as {
			page: { returned: number; has_more: boolean; total: number }
			integrations: unknown[]
		}

		expect(parsed.page.has_more).toBe(true)
		expect(parsed.page.returned).toBe(parsed.integrations.length)
		expect(parsed.page.total).toBe(100)
	})

	it('keeps a summary that sits ahead of the rows', () => {
		const text = JSON.stringify({
			summary: { active: ['slack'] },
			integrations: rowsOf(100),
		})
		const parsed = JSON.parse(capToolOutput(text, MAX)) as { summary: { active: string[] } }
		expect(parsed.summary.active).toEqual(['slack'])
	})

	it('cuts a result that is a bare array, wrapping it so the notice has somewhere to go', () => {
		const parsed = JSON.parse(capToolOutput(JSON.stringify(rowsOf(100)), MAX)) as {
			voice_truncated: { omitted: number }
			rows: unknown[]
		}
		expect(parsed.voice_truncated.omitted).toBeGreaterThan(0)
		expect(parsed.rows.length).toBeGreaterThan(0)
	})

	it('cuts the longest list when a result has several', () => {
		const text = JSON.stringify({ tags: ['a', 'b'], items: rowsOf(100) })
		const parsed = JSON.parse(capToolOutput(text, MAX)) as { tags: string[]; items: unknown[] }
		expect(parsed.tags).toEqual(['a', 'b'])
		expect(parsed.items.length).toBeLessThan(100)
	})

	it('falls back to the plain cut for text that is not JSON, as before', () => {
		const out = capToolOutput('x'.repeat(50_000), MAX)
		expect(out.length).toBeLessThan(MAX + 20)
		expect(out.endsWith('[truncated]')).toBe(true)
	})

	it('falls back to the plain cut when JSON has no list to cut', () => {
		const out = capToolOutput(JSON.stringify({ body: 'y'.repeat(50_000) }), MAX)
		expect(out.endsWith('[truncated]')).toBe(true)
	})

	it('falls back to the plain cut when not even one whole row fits', () => {
		const out = capToolOutput(JSON.stringify({ items: [{ body: 'z'.repeat(50_000) }] }), MAX)
		expect(out.endsWith('[truncated]')).toBe(true)
	})
})
