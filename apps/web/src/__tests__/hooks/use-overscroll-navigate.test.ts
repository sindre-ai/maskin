import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn().mockResolvedValue(undefined)
const mockScrollContainerRef: RefObject<HTMLDivElement | null> = { current: null }

vi.mock('@/lib/scroll-container-context', () => ({
	useScrollContainer: () => mockScrollContainerRef,
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

import { useOverscrollNavigate } from '@/hooks/use-overscroll-navigate'

const pages = [
	{ label: 'General', to: '/$workspaceId/settings' },
	{ label: 'Objects', to: '/$workspaceId/settings/objects' },
	{ label: 'Members', to: '/$workspaceId/settings/members' },
]

function createMockScrollElement(
	overrides: Partial<{
		scrollHeight: number
		scrollTop: number
		clientHeight: number
	}> = {},
) {
	const el = document.createElement('div')
	Object.defineProperty(el, 'scrollHeight', {
		value: overrides.scrollHeight ?? 1000,
		writable: true,
	})
	Object.defineProperty(el, 'scrollTop', {
		value: overrides.scrollTop ?? 500,
		writable: true,
		configurable: true,
	})
	Object.defineProperty(el, 'clientHeight', {
		value: overrides.clientHeight ?? 500,
		writable: true,
	})
	return el
}

function fireWheel(el: HTMLElement, deltaY: number) {
	const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
	el.dispatchEvent(event)
	return event
}

describe('useOverscrollNavigate', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		mockScrollContainerRef.current = null
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('returns initial state when no scroll container', () => {
		const { result } = renderHook(() => useOverscrollNavigate(pages, 0, 'ws-1'))

		expect(result.current).toEqual({
			direction: null,
			progress: 0,
			targetLabel: null,
		})
	})

	it('does not accumulate when not at boundary', () => {
		const el = createMockScrollElement({ scrollTop: 250 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 1, 'ws-1'))

		act(() => {
			fireWheel(el, 100)
		})

		expect(result.current.direction).toBeNull()
		expect(result.current.progress).toBe(0)
	})

	it('accumulates overscroll at bottom boundary scrolling down', () => {
		// At bottom: scrollHeight - scrollTop - clientHeight < 2
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 0, 'ws-1'))

		act(() => {
			fireWheel(el, 100)
		})

		expect(result.current.direction).toBe('next')
		expect(result.current.progress).toBeCloseTo(100 / 300)
		expect(result.current.targetLabel).toBe('Objects')
	})

	it('accumulates overscroll at top boundary scrolling up', () => {
		// At top: scrollTop < 2
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 1, 'ws-1'))

		act(() => {
			fireWheel(el, -100)
		})

		expect(result.current.direction).toBe('prev')
		expect(result.current.progress).toBeCloseTo(100 / 300)
		expect(result.current.targetLabel).toBe('General')
	})

	it('navigates when threshold is reached', () => {
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		renderHook(() => useOverscrollNavigate(pages, 0, 'ws-1'))

		act(() => {
			fireWheel(el, 150)
			fireWheel(el, 150)
		})

		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/settings/objects',
			params: { workspaceId: 'ws-1' },
		})
	})

	it('does not navigate next on last page', () => {
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 2, 'ws-1'))

		act(() => {
			fireWheel(el, 300)
		})

		expect(result.current.direction).toBeNull()
		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('does not navigate prev on first page', () => {
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 0, 'ws-1'))

		act(() => {
			fireWheel(el, -300)
		})

		expect(result.current.direction).toBeNull()
		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('resets progress after decay timeout', () => {
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 0, 'ws-1'))

		act(() => {
			fireWheel(el, 100)
		})

		expect(result.current.progress).toBeGreaterThan(0)

		act(() => {
			vi.advanceTimersByTime(500)
		})

		expect(result.current.direction).toBeNull()
		expect(result.current.progress).toBe(0)
	})

	it('works on short pages without overflow', () => {
		// No overflow: scrollHeight === clientHeight
		const el = createMockScrollElement({ scrollHeight: 500, scrollTop: 0, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 1, 'ws-1'))

		act(() => {
			fireWheel(el, 100)
		})

		// Should still accumulate since there's no overflow to scroll through
		expect(result.current.direction).toBe('next')
		expect(result.current.progress).toBeGreaterThan(0)
	})

	it('resets when scroll direction changes', () => {
		const el = createMockScrollElement({ scrollHeight: 500, scrollTop: 0, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		const { result } = renderHook(() => useOverscrollNavigate(pages, 1, 'ws-1'))

		act(() => {
			fireWheel(el, 100) // scroll down → next
		})
		expect(result.current.direction).toBe('next')

		act(() => {
			fireWheel(el, -100) // scroll up → prev, should reset first
		})
		expect(result.current.direction).toBe('prev')
		// Progress should be from single event, not accumulated from both directions
		expect(result.current.progress).toBeCloseTo(100 / 300)
	})

	it('prevents default on wheel events during accumulation', () => {
		const el = createMockScrollElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
		mockScrollContainerRef.current = el as unknown as HTMLDivElement

		renderHook(() => useOverscrollNavigate(pages, 0, 'ws-1'))

		let event: WheelEvent | undefined
		act(() => {
			event = fireWheel(el, 100)
		})

		expect(event?.defaultPrevented).toBe(true)
	})
})
