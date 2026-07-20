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
	// rAF is used to throttle the scroll handler — flush synchronously in tests.
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		cb(0)
		return 1
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ''
})

const opts = { enabled: true, objectType: 'bet', objectId: 'obj-1' }

describe('useScrollToTopEmitter', () => {
	it('does not emit if the user never scrolls a full viewport down', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(400) // half a viewport
		handle.setScroll(0) // back to top

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('emits once after scrolling ≥ 1 viewport down and returning within 24px of the top', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1600) // 2 viewports down — arms the trigger
		handle.setScroll(1200) // still down
		handle.setScroll(10) // back within 24px of top — fires

		expect(trackScrollToTop).toHaveBeenCalledTimes(1)
		expect(trackScrollToTop).toHaveBeenCalledWith({
			object_type: 'bet',
			object_id: 'obj-1',
			scroll_depth_at_start_px: 1600,
			viewports_scrolled: 2,
		})
	})

	it('does not fire twice on the same upward gesture — must re-scroll ≥ 1 viewport down to re-arm', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1000) // ≥ 1 viewport — arms
		handle.setScroll(5) // fires
		handle.setScroll(20) // still near top — must not fire again
		handle.setScroll(0)
		handle.setScroll(15)

		expect(trackScrollToTop).toHaveBeenCalledTimes(1)

		handle.setScroll(900) // fresh ≥ 1 viewport — re-arms
		handle.setScroll(0) // fires again

		expect(trackScrollToTop).toHaveBeenCalledTimes(2)
	})

	it('does not fire when the user returns from less than one viewport down', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(500) // under 1 viewport — never arms
		handle.setScroll(0)

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('is a noop when disabled', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter({ ...opts, enabled: false }))

		handle.setScroll(2000)
		handle.setScroll(0)

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('is a noop when no [data-scroll-root] is present', () => {
		// No scroll root mounted.
		renderHook(() => useScrollToTopEmitter(opts))
		expect(trackScrollToTop).not.toHaveBeenCalled()
	})

	it('rounds viewports_scrolled to 1 decimal', () => {
		const handle = mountScrollRoot(800)
		renderHook(() => useScrollToTopEmitter(opts))

		handle.setScroll(1237) // 1237 / 800 = 1.54625 → 1.5
		handle.setScroll(0)

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

		expect(trackScrollToTop).not.toHaveBeenCalled()
	})
})
