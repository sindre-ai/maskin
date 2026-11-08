import { fitChips } from '@/lib/fit-chips'
import { describe, expect, it } from 'vitest'

describe('fitChips', () => {
	const widths = [50, 70, 70, 70, 70]
	const gap = 8
	const moreWidth = 60

	it('shows every chip when they fit and draws no More', () => {
		// 330 of chips + 4 gaps = 362
		expect(fitChips({ available: 362, widths, moreWidth, gap })).toBe(5)
		expect(fitChips({ available: 1000, widths, moreWidth, gap })).toBe(5)
	})

	it('folds the overflow behind More as soon as the row is one pixel short', () => {
		expect(fitChips({ available: 361, widths, moreWidth, gap })).toBeLessThan(5)
	})

	it('keeps as many chips as leave room for the More chip', () => {
		// 3 chips = 190 + 16 gaps = 206, plus a gap and More = 274
		expect(fitChips({ available: 274, widths, moreWidth, gap })).toBe(3)
		expect(fitChips({ available: 273, widths, moreWidth, gap })).toBe(2)
	})

	it('never folds the first chip, however narrow the row', () => {
		expect(fitChips({ available: 10, widths, moreWidth, gap })).toBe(1)
		expect(fitChips({ available: 0, widths, moreWidth, gap })).toBe(1)
	})

	it('has nothing to show for no chips', () => {
		expect(fitChips({ available: 300, widths: [], moreWidth, gap })).toBe(0)
	})

	it('shows a single chip whole, without More', () => {
		expect(fitChips({ available: 50, widths: [50], moreWidth, gap })).toBe(1)
	})
})
