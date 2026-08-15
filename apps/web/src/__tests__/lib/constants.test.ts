import { describe, expect, it } from 'vitest'

import {
	API_BASE,
	defaultStatusColor,
	defaultTypeColor,
	getStatusColor,
	getTypeColor,
	statusColors,
	statusLabel,
	typeColors,
	typeLabel,
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

	it('maps loop statuses to their color-coded chips', () => {
		expect(getStatusColor('holding')).toEqual({
			bg: 'bg-status-holding-bg',
			text: 'text-status-holding-text',
		})
		expect(getStatusColor('at-risk')).toEqual({
			bg: 'bg-status-at_risk-bg',
			text: 'text-status-at_risk-text',
		})
		expect(getStatusColor('breached')).toEqual({
			bg: 'bg-status-breached-bg',
			text: 'text-status-breached-text',
		})
	})
})

describe('typeLabel', () => {
	it('humanizes the core object types', () => {
		expect(typeLabel('insight')).toBe('Insight')
		expect(typeLabel('bet')).toBe('Bet')
		expect(typeLabel('task')).toBe('Task')
	})

	it('falls back to the raw type for unknown types', () => {
		expect(typeLabel('meeting')).toBe('meeting')
	})
})

describe('statusLabel', () => {
	it('maps the shipped workflow statuses to their labels', () => {
		expect(statusLabel('active')).toBe('Active')
		expect(statusLabel('in_progress')).toBe('In progress')
		expect(statusLabel('todo')).toBe('To do')
		expect(statusLabel('define')).toBe('Define')
		expect(statusLabel('in_review')).toBe('In review')
		expect(statusLabel('done')).toBe('Done')
		expect(statusLabel('validated')).toBe('Validated')
	})

	it('humanizes custom statuses by replacing underscores', () => {
		expect(statusLabel('waiting_for_input')).toBe('waiting for input')
	})
})

describe('API_BASE', () => {
	it('equals /api', () => {
		expect(API_BASE).toBe('/api')
	})
})
