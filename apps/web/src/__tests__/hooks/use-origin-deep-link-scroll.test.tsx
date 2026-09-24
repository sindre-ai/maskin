import { useOriginDeepLinkScroll } from '@/hooks/use-origin-deep-link-scroll'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom lacks scrollIntoView; the hook calls it, so stub it before every test.
beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn()
	document.body.innerHTML = ''
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

function mountMessage(id: number, sessionTitle?: string) {
	const node = document.createElement('div')
	node.setAttribute('data-message-id', String(id))
	if (sessionTitle) node.dataset.spawnSessionTitle = sessionTitle
	document.body.appendChild(node)
	return node
}

describe('useOriginDeepLinkScroll', () => {
	it('stays silent when there is no message id', () => {
		const { result } = renderHook(() =>
			useOriginDeepLinkScroll({ messageId: null, dataTrigger: null }),
		)
		expect(result.current).toBe('')
	})

	it('scrolls the message into view, stamps the spawn + pulse markers, and announces', () => {
		const node = mountMessage(4242, 'Draft Slice 1 & Slice 2 outline')

		const { result } = renderHook(() =>
			useOriginDeepLinkScroll({ messageId: 4242, dataTrigger: 'first-page' }),
		)

		expect(node.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
		// Persistent marker set → picked up by the CSS rule that draws the
		// vertical --brand rail on the right edge.
		expect(node.dataset.originSpawn).toBe('true')
		// Transient marker set → picked up by the 2.2s keyframe animation.
		expect(node.dataset.originPulse).toBe('true')
		expect(result.current).toBe(
			'Jumped to message from origin. Session "Draft Slice 1 & Slice 2 outline".',
		)
	})

	it('clears the pulse marker after 2.2s while keeping the persistent spawn marker', () => {
		const node = mountMessage(4242)
		renderHook(() => useOriginDeepLinkScroll({ messageId: 4242, dataTrigger: 'p' }))

		expect(node.dataset.originPulse).toBe('true')
		act(() => {
			vi.advanceTimersByTime(2200)
		})
		expect(node.dataset.originPulse).toBeUndefined()
		// Persistent marker survives the pulse cleanup.
		expect(node.dataset.originSpawn).toBe('true')
	})

	it('does nothing when the target message is not in the DOM yet', () => {
		const { result } = renderHook(() =>
			useOriginDeepLinkScroll({ messageId: 4242, dataTrigger: 'p' }),
		)
		expect(result.current).toBe('')
	})

	it('runs the jump once the DOM catches up (dataTrigger changes → effect re-runs)', () => {
		// First render: target isn't mounted yet, so nothing happens.
		const { rerender, result } = renderHook(
			({ trigger }) => useOriginDeepLinkScroll({ messageId: 4242, dataTrigger: trigger }),
			{ initialProps: { trigger: 'empty' as unknown } },
		)
		expect(result.current).toBe('')

		// Now the message data arrives and the row mounts. Re-render with a
		// fresh dataTrigger to signal the query updated.
		mountMessage(4242)
		rerender({ trigger: 'first-page' as unknown })

		expect(result.current).toBe('Jumped to message from origin.')
	})

	it('does not re-fire for the same message id on unrelated re-renders', () => {
		const node = mountMessage(4242)
		const { rerender } = renderHook(
			({ trigger }) => useOriginDeepLinkScroll({ messageId: 4242, dataTrigger: trigger }),
			{ initialProps: { trigger: 'a' as unknown } },
		)

		expect(node.scrollIntoView).toHaveBeenCalledTimes(1)

		rerender({ trigger: 'b' as unknown })
		rerender({ trigger: 'c' as unknown })

		// The jumpedForRef guard means only the first paint fires the scroll —
		// SSE live updates and pagination re-renders won't re-yank the view.
		expect(node.scrollIntoView).toHaveBeenCalledTimes(1)
	})
})
