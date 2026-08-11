import { afterEach, describe, expect, it, vi } from 'vitest'

import {
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
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.resetModules()
	})

	it('defaults to the relative /api path (Vite dev proxy) when VITE_API_BASE_URL is unset', async () => {
		const mod = await import('@/lib/constants')
		expect(mod.API_BASE).toBe('/api')
	})

	it('uses the absolute VITE_API_BASE_URL when set (the iOS shell build)', async () => {
		vi.stubEnv('VITE_API_BASE_URL', 'https://api.maskin.example')
		const mod = await import('@/lib/constants')
		expect(mod.API_BASE).toBe('https://api.maskin.example')
	})
})
