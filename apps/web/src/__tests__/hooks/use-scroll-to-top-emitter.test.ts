import { useScrollToTopEmitter } from '@/hooks/use-scroll-to-top-emitter'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackScrollToTop = vi.hoisted(() => vi.fn())
vi.mock('@/lib/analytics', () => ({ trackScrollToTop }))

interface ScrollRootHandle {
	root: HTMLElement
	setScroll: (px: number) => void
}

function mountScrollRoot(viewportHeight: number): ScrollRootHandle {
	const root = document.createElement('div')
	root.setAttribute('data-scroll-root', '')
	Object.defineProperty(root, 'clientHeight', {
		configurable: true,
		get: () => viewportHeight,
	})
	let scrollTop = 0
	Object.defineProperty(root, 'scrollTop', {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = v
		},
	})
	document.body.appendChild(root)
	return {
		root,
		setScroll(px: number) {
			scrollTop = px
			act(() => {
				root.dispatchEvent(new Event('scroll'))
			})
		},
	}
}

beforeEach(() => {
	document.body.innerHTML = ''
	trackScrollToTop.mockClear()
	vi.useFakeTimers()
	// rAF is used to throttle the scroll handler — flush synchronously in tests.
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		cb(0)
		return 1
	})
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	document.body.innerHTML = ''
})

const opts = { enabled: true, objectSubtype: 'bet', objectId: 'obj-1' }

// Advance past the 250ms settle window so the emit timer fires.
const flushSettle = () => act(() => vi.advanceTimersByTime(300))

describe('useScrollToTopEmitter', () => {
	it('does not emit if the user never scrolls a full viewport down', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(400) // half a viewport
		handle.setScroll(0) // back to top
		flushSettle()

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('emits once after scrolling ≥ 1 viewport down and returning near the top', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1600) // 2 viewports down — arms the trigger
		handle.setScroll(1200) // still down
		handle.setScroll(40) // near the top — arms the settle timer
		flushSettle()

		expect(trackScrollToTop).toHaveBeenCalledTimes(1)
		expect(trackScrollToTop).toHaveBeenCalledWith({
			entity_id: 'obj-1',
			entity_type: 'object',
			object_subtype: 'bet',
			scroll_depth_at_start_px: 1600,
			viewports_scrolled: 2,
		})
	})

	it('cancels the emit when the user scrolls back away before the settle window closes', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1600)
		handle.setScroll(40) // near top — settle timer armed
		act(() => vi.advanceTimersByTime(100))
		handle.setScroll(400) // scrolls back away before settle fires
		flushSettle()

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('does not re-emit while sitting near the top (jitter can not re-fire)', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1000)
		handle.setScroll(5)
		flushSettle()
		expect(trackScrollToTop).toHaveBeenCalledTimes(1)

		// Small jitter at the top must not re-emit.
		handle.setScroll(20)
		handle.setScroll(0)
		handle.setScroll(15)
		flushSettle()

		expect(trackScrollToTop).toHaveBeenCalledTimes(1)
	})

	it('re-arms only after another full viewport of downward scroll from the post-emit position', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1000)
		handle.setScroll(5)
		flushSettle()
		expect(trackScrollToTop).toHaveBeenCalledTimes(1)

		// Half a viewport down and back — must not re-emit.
		handle.setScroll(400)
		handle.setScroll(20)
		flushSettle()
		expect(trackScrollToTop).toHaveBeenCalledTimes(1)

		// A fresh full viewport down and back — arms and fires again.
		handle.setScroll(900)
		handle.setScroll(0)
		flushSettle()
		expect(trackScrollToTop).toHaveBeenCalledTimes(2)
	})

	it('does not fire when the user returns from less than one viewport down', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(500) // under 1 viewport — never arms
		handle.setScroll(0)
		flushSettle()

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('is a noop when disabled', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter({ ...opts, enabled: false }))

		handle.setScroll(2000)
		handle.setScroll(0)
		flushSettle()

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('is a noop when no [data-scroll-root] is present', () => {
		renderHook(() => useScrollToTopEmitter(opts))
		flushSettle()
		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('rounds viewports_scrolled to 1 decimal', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1237) // 1237 / 800 = 1.54625 → 1.5
		handle.setScroll(0)
		flushSettle()

		expect(trackScrollToTop).toHaveBeenCalledWith(
			expect.objectContaining({
				scroll_depth_at_start_px: 1237,
				viewports_scrolled: 1.5,
			}),
		)
	})

	it('cleans up the scroll listener on unmount', () => {
		const handle = mountScrollRoot(800)
		const { unmount } = renderHook(() => useScrollToTopEmitter(opts))

		unmount()

		handle.setScroll(2000)
		handle.setScroll(0)
		flushSettle()

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})
})
