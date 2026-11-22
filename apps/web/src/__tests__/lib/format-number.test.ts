import { formatFigure } from '@/lib/format-number'
import { describe, expect, it } from 'vitest'

describe('formatFigure', () => {
	const group = (1000).toLocaleString().replace(/\d/g, '')

	it('groups thousands the way the reader locale does', () => {
		expect(formatFigure(992880)).toBe(`992${group}880`)
	})

	it('keeps at most one decimal and no padding', () => {
		expect(formatFigure(6.34)).toBe((6.3).toLocaleString(undefined, { maximumFractionDigits: 1 }))
		expect(formatFigure(8)).toBe('8')
	})

	it('leaves a non-number readable', () => {
		expect(formatFigure(Number.NaN)).toBe('NaN')
	})
})
