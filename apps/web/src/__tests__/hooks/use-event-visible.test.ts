import { useEventVisible } from '@/hooks/use-event-visible'
import { render } from '@testing-library/react'
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
})
