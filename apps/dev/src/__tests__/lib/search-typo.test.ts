import { canHaveTypo, titleTypoDistance } from '../../lib/search-typo'

describe('canHaveTypo', () => {
	it('gives words of three letters or fewer no typo budget', () => {
		expect(canHaveTypo('cat')).toBe(false)
		expect(canHaveTypo('db')).toBe(false)
		expect(canHaveTypo('magn')).toBe(true)
	})
})

describe('titleTypoDistance', () => {
	it('counts a missing, swapped or wrong letter as one typo', () => {
		expect(titleTypoDistance(['mgnus'], 'Magnus')).toBe(1)
		expect(titleTypoDistance(['magnsu'], 'Magnus')).toBe(1)
		expect(titleTypoDistance(['magnis'], 'Magnus')).toBe(1)
	})

	it('is 0 when the word is in the title as typed, and for the start of a word', () => {
		expect(titleTypoDistance(['magnus'], 'Magnus Hansen')).toBe(0)
		expect(titleTypoDistance(['magn'], 'Magnus')).toBe(0)
	})

	it('forgives a typo in the start of a longer word', () => {
		expect(titleTypoDistance(['magb'], 'Magnus')).toBe(1)
	})

	it('allows two typos from eight letters, one below that', () => {
		expect(titleTypoDistance(['quartrly'], 'Quarterly plan')).toBe(1)
		expect(titleTypoDistance(['quaterly1'], 'Quarterly plan')).toBe(2)
		expect(titleTypoDistance(['magnxx'], 'Magnus')).toBeNull()
	})

	it('does not forgive typos in words of three letters or fewer', () => {
		expect(titleTypoDistance(['cat'], 'cut')).toBeNull()
	})

	it('needs every word, in any order, and adds up the typos', () => {
		expect(titleTypoDistance(['baker', 'anna'], 'Anna Baker')).toBe(0)
		expect(titleTypoDistance(['bakr', 'anna'], 'Anna Baker')).toBe(1)
		expect(titleTypoDistance(['anna', 'zebra'], 'Anna Baker')).toBeNull()
	})

	it('rejects unrelated words that are far from the term', () => {
		expect(titleTypoDistance(['magnus'], 'Manager')).toBeNull()
	})
})
