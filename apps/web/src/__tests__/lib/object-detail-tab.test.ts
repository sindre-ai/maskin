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
