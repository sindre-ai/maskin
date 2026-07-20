import {
	__resetBackNavTrackerForTesting,
	consumeArrivalNavType,
	initBackNavTracker,
	wasRecentBackNav,
} from '@/lib/back-nav-tracker'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	__resetBackNavTrackerForTesting()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('back-nav-tracker', () => {
	it('reports false when no popstate has fired since boot', () => {
		initBackNavTracker()

		expect(wasRecentBackNav()).toBe(false)
	})

	it('reports false on a warm/fast page load when performance.now() is small', () => {
		// Regression guard for the pre-fix sentinel `lastPopstateAt = 0`, where a
		// warm hard-refresh with `performance.now() ~ 10ms` at mount would pass
		// `now - 0 < 100` and fire a false-positive `nav_type: 'back'` event —
		// biasing the ship-metric denominator. With NEGATIVE_INFINITY the delta is
		// +Infinity, so the guard cannot be tripped without an actual popstate.
		vi.spyOn(performance, 'now').mockReturnValue(10)
		initBackNavTracker()

		expect(wasRecentBackNav()).toBe(false)
	})

	it('reports true when a popstate fired within the last 100 ms', () => {
		initBackNavTracker()
		const spy = vi.spyOn(performance, 'now').mockReturnValue(1000)
		window.dispatchEvent(new PopStateEvent('popstate'))
		spy.mockReturnValue(1050)

		expect(wasRecentBackNav()).toBe(true)
	})

	it('reports false once more than 100 ms have passed since the last popstate', () => {
		initBackNavTracker()
		const spy = vi.spyOn(performance, 'now').mockReturnValue(1000)
		window.dispatchEvent(new PopStateEvent('popstate'))
		spy.mockReturnValue(1200)

		expect(wasRecentBackNav()).toBe(false)
	})

	it('is idempotent — a second init call does not attach a duplicate listener', () => {
		const addSpy = vi.spyOn(window, 'addEventListener')

		initBackNavTracker()
		initBackNavTracker()

		const popstateCalls = addSpy.mock.calls.filter(([type]) => type === 'popstate')
		expect(popstateCalls).toHaveLength(1)
	})
})

describe('consumeArrivalNavType', () => {
	function mockNavigationEntry(type: NavigationTimingType | undefined): void {
		const entries = type ? [{ type } as PerformanceNavigationTiming] : []
		vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries)
	}

	it('returns "back" when a popstate fired within the window', () => {
		initBackNavTracker()
		const spy = vi.spyOn(performance, 'now').mockReturnValue(1000)
		window.dispatchEvent(new PopStateEvent('popstate'))
		spy.mockReturnValue(1050)

		expect(consumeArrivalNavType()).toBe('back')
	})

	it('returns "direct" on the first arrival when the initial navigation was a URL-bar entry', () => {
		mockNavigationEntry('navigate')
		initBackNavTracker()

		expect(consumeArrivalNavType()).toBe('direct')
	})

	it('returns "direct" on the first arrival when the initial navigation was a hard refresh', () => {
		mockNavigationEntry('reload')
		initBackNavTracker()

		expect(consumeArrivalNavType()).toBe('direct')
	})

	it('returns "back" on the first arrival when the initial navigation was browser back/forward at page load', () => {
		mockNavigationEntry('back_forward')
		initBackNavTracker()

		expect(consumeArrivalNavType()).toBe('back')
	})

	it('returns "link" on subsequent arrivals with no popstate (SPA Link nav)', () => {
		mockNavigationEntry('navigate')
		initBackNavTracker()

		expect(consumeArrivalNavType()).toBe('direct')
		expect(consumeArrivalNavType()).toBe('link')
		expect(consumeArrivalNavType()).toBe('link')
	})

	it('prefers "back" over "link" when a popstate fires between arrivals', () => {
		mockNavigationEntry('navigate')
		initBackNavTracker()
		const spy = vi.spyOn(performance, 'now').mockReturnValue(1000)

		expect(consumeArrivalNavType()).toBe('direct')

		window.dispatchEvent(new PopStateEvent('popstate'))
		spy.mockReturnValue(1050)

		expect(consumeArrivalNavType()).toBe('back')
	})
})
