import { describe, expect, it } from 'vitest'

import { folderDisplayPath, truncatePathAtSeparator } from '@/lib/drive-watches'

describe('folderDisplayPath', () => {
	it('is the folder name when the watch has no stored path', () => {
		expect(folderDisplayPath({ name: 'Meet Recordings', path: null })).toBe('Meet Recordings')
	})

	it('closes the stored ancestor path with the folder name', () => {
		expect(folderDisplayPath({ name: 'Briefs', path: 'Clients/Acme' })).toBe('Clients/Acme/Briefs')
	})

	it('does not repeat the folder name when the path already ends in it', () => {
		expect(folderDisplayPath({ name: 'Briefs', path: '/Clients/Acme/Briefs' })).toBe(
			'/Clients/Acme/Briefs',
		)
		expect(folderDisplayPath({ name: 'Briefs', path: 'Clients/Acme/Briefs/' })).toBe(
			'Clients/Acme/Briefs',
		)
	})
})

describe('truncatePathAtSeparator', () => {
	it('leaves a short path alone', () => {
		expect(truncatePathAtSeparator('Clients/Acme/Briefs')).toBe('Clients/Acme/Briefs')
	})

	it('drops leading folders at a separator, never part of a name', () => {
		const path = 'My Drive/Customers/Acme Studio/Quarterly business reviews/2026/Q3 briefs'
		const short = truncatePathAtSeparator(path, 45)
		expect(short).toBe('…/Quarterly business reviews/2026/Q3 briefs')
		// Every kept piece is a whole folder name from the original path.
		const whole = path.split('/')
		for (const piece of short.replace(/^…\//, '').split('/')) expect(whole).toContain(piece)
	})

	it('always keeps the last folder whole, even when it alone exceeds the limit', () => {
		const long = 'A folder name that is much longer than the limit allows for display'
		expect(truncatePathAtSeparator(`Parent/${long}`, 20)).toBe(`…/${long}`)
	})

	it('returns the path unchanged when every folder fits after all', () => {
		expect(truncatePathAtSeparator('a/b/c', 3)).toBe('…/c')
		expect(truncatePathAtSeparator('abcdef', 3)).toBe('abcdef')
	})
})
