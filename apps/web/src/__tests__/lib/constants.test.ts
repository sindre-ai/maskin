import { describe, expect, it } from 'vitest'

import {
	API_BASE,
	defaultStatusColor,
	defaultTypeColor,
	getStatusColor,
	getTypeColor,
	statusColors,
	statusStage,
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

describe('API_BASE', () => {
	it('equals /api', () => {
		expect(API_BASE).toBe('/api')
	})
})

describe('statusStage', () => {
	it.each([
		['done', 'done'],
		['in_review', 'review'],
		['In progress', 'progress'],
		['active', 'progress'],
		['todo', 'todo'],
		['backlog', 'todo'],
		['cancelled', 'cancelled'],
		['canceled', 'cancelled'],
		['discarded', 'cancelled'],
		['failed', 'cancelled'],
		['blocked', 'blocked'],
		['paused', 'blocked'],
		['parked', 'blocked'],
		['at_risk', 'blocked'],
	] as const)('maps %s to %s', (status, stage) => {
		expect(statusStage(status)).toBe(stage)
	})

	it('treats a custom workspace status as unknown, never as not started', () => {
		expect(statusStage('waiting_for_legal')).toBe('unknown')
		expect(statusStage('')).toBe('unknown')
	})
})
