import { useEventVisible } from '@/hooks/use-event-visible'
import { act, render } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void

let lastCallback: ObserverCallback | null = null

class StubObserver {
	constructor(cb: ObserverCallback) {
		lastCallback = cb
	}
	observe() {
		/* noop */
	}
	disconnect() {
		/* noop */
	}
	unobserve() {
		/* noop */
	}
	takeRecords() {
		return []
	}
}

function Probe({ eventId, onVisible }: { eventId: number; onVisible: (id: number) => void }) {
	const ref = useEventVisible(eventId, onVisible)
	return React.createElement('div', { ref, 'data-testid': 'probe' })
}

describe('useEventVisible', () => {
	beforeEach(() => {
		lastCallback = null
		// biome-ignore lint/suspicious/noExplicitAny: replacing the global for tests
		;(globalThis as any).IntersectionObserver = StubObserver
	})

	it('fires onVisible once when the element intersects', () => {
		const onVisible = vi.fn()
		render(React.createElement(Probe, { eventId: 42, onVisible }))

		expect(lastCallback).not.toBeNull()
		lastCallback?.([{ isIntersecting: true }])
		expect(onVisible).toHaveBeenCalledTimes(1)
		expect(onVisible).toHaveBeenCalledWith(42)

		// Further intersections should not double-fire.
		lastCallback?.([{ isIntersecting: true }])
		expect(onVisible).toHaveBeenCalledTimes(1)
	})

	it('does not fire when not intersecting', () => {
		const onVisible = vi.fn()
		render(React.createElement(Probe, { eventId: 1, onVisible }))

		lastCallback?.([{ isIntersecting: false }])
		expect(onVisible).not.toHaveBeenCalled()
	})

	it('re-arms and fires again when eventId changes', () => {
		const onVisible = vi.fn()
		const { rerender } = render(React.createElement(Probe, { eventId: 10, onVisible }))

		lastCallback?.([{ isIntersecting: true }])
		expect(onVisible).toHaveBeenCalledTimes(1)
		expect(onVisible).toHaveBeenLastCalledWith(10)

		// New comment arrives — eventId bumps. The hook must re-arm so the next
		// intersection advances the high-water-mark to the new id.
		act(() => {
			rerender(React.createElement(Probe, { eventId: 20, onVisible }))
		})
		lastCallback?.([{ isIntersecting: true }])
		expect(onVisible).toHaveBeenCalledTimes(2)
		expect(onVisible).toHaveBeenLastCalledWith(20)

		// And it still won't double-fire for the same id.
		lastCallback?.([{ isIntersecting: true }])
		expect(onVisible).toHaveBeenCalledTimes(2)
	})
})
