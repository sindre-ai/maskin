import { parseObjectDetailTab } from '@/lib/object-detail-tab'

describe('parseObjectDetailTab', () => {
	it('returns the tab for a known value', () => {
		expect(parseObjectDetailTab('related')).toBe('related')
		expect(parseObjectDetailTab('activity')).toBe('activity')
	})

	it('returns undefined for unknown or non-string values', () => {
		expect(parseObjectDetailTab('timeline')).toBeUndefined()
		expect(parseObjectDetailTab(3)).toBeUndefined()
		expect(parseObjectDetailTab(undefined)).toBeUndefined()
	})
})

describe('parseObjectDetailTab view tabs', () => {
	it('accepts a view tab by its shape', () => {
		expect(parseObjectDetailTab('view-0')).toBe('view-0')
		expect(parseObjectDetailTab('view-12')).toBe('view-12')
	})

	it('drops anything that only looks like one', () => {
		expect(parseObjectDetailTab('view-')).toBeUndefined()
		expect(parseObjectDetailTab('view-x')).toBeUndefined()
		expect(parseObjectDetailTab('view-1/../x')).toBeUndefined()
	})
})
