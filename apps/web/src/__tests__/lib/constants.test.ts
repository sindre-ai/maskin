import { describe, expect, it } from 'vitest'

import {
	API_BASE,
	defaultStatusColor,
	defaultTypeColor,
	getStatusColor,
	getTypeColor,
	statusColors,
	typeColors,
} from '@/lib/constants'

describe('getTypeColor', () => {
	it('returns correct color for insight', () => {
		expect(getTypeColor('insight')).toEqual(typeColors.insight)
	})

	it('returns correct color for bet', () => {
		expect(getTypeColor('bet')).toEqual(typeColors.bet)
	})

	it('returns correct color for task', () => {
		expect(getTypeColor('task')).toEqual(typeColors.task)
	})

	it('returns defaultTypeColor for unknown type', () => {
		expect(getTypeColor('unknown')).toEqual(defaultTypeColor)
	})
})

describe('getStatusColor', () => {
	it('returns correct color for known statuses', () => {
		expect(getStatusColor('active')).toEqual(statusColors.active)
		expect(getStatusColor('done')).toEqual(statusColors.done)
		expect(getStatusColor('failed')).toEqual(statusColors.failed)
		expect(getStatusColor('new')).toEqual(statusColors.new)
	})

	it('returns defaultStatusColor for unknown status', () => {
		expect(getStatusColor('nonexistent')).toEqual(defaultStatusColor)
	})
})

describe('API_BASE', () => {
	it('equals /api', () => {
		expect(API_BASE).toBe('/api')
	})
})
