import {
	__resetFirstRenderTrackerForTesting,
	useTrackFirstRender,
} from '@/hooks/use-track-first-render'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.fn()

vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackEvent: (name: string, props: Record<string, unknown>) => trackEvent(name, props),
	}
})

// `key` is a reserved React prop (consumed by reconciliation), so this probe
// takes `dedupKey` instead and forwards it to the hook — otherwise the test
// would silently pass undefined into the hook.
function Probe(props: {
	dedupKey: string | null | undefined
	eventName: string
	enabled?: boolean
	payload: Record<string, string | number | boolean | null | undefined>
}) {
	useTrackFirstRender({
		key: props.dedupKey,
		eventName: props.eventName,
		enabled: props.enabled,
		props: props.payload,
	})
	return null
}

beforeEach(() => {
	trackEvent.mockClear()
	__resetFirstRenderTrackerForTesting()
})

afterEach(() => {
	__resetFirstRenderTrackerForTesting()
})

describe('useTrackFirstRender', () => {
	it('fires once when key + enabled resolve on mount', () => {
		render(<Probe dedupKey="k1" eventName="comment_rendered" payload={{ a: 1 }} />)

		expect(trackEvent).toHaveBeenCalledTimes(1)
		expect(trackEvent).toHaveBeenCalledWith('comment_rendered', { a: 1 })
	})

	it('does not re-fire on re-render of the same key', () => {
		const { rerender } = render(<Probe dedupKey="k1" eventName="e" payload={{ v: 1 }} />)
		rerender(<Probe dedupKey="k1" eventName="e" payload={{ v: 2 }} />)
		rerender(<Probe dedupKey="k1" eventName="e" payload={{ v: 3 }} />)

		expect(trackEvent).toHaveBeenCalledTimes(1)
		expect(trackEvent).toHaveBeenCalledWith('e', { v: 1 })
	})

	it('does not fire until enabled flips true (deferred until actor loads)', () => {
		const { rerender } = render(
			<Probe dedupKey={null} eventName="e" enabled={false} payload={{ actor_type: null }} />,
		)
		expect(trackEvent).not.toHaveBeenCalled()

		rerender(<Probe dedupKey="k1" eventName="e" enabled={true} payload={{ actor_type: 'agent' }} />)
		expect(trackEvent).toHaveBeenCalledTimes(1)
		expect(trackEvent).toHaveBeenCalledWith('e', { actor_type: 'agent' })
	})

	it('dedupes across unmount + remount (virtualization scroll)', () => {
		const { unmount } = render(<Probe dedupKey="k1" eventName="e" payload={{}} />)
		expect(trackEvent).toHaveBeenCalledTimes(1)
		unmount()

		render(<Probe dedupKey="k1" eventName="e" payload={{}} />)
		expect(trackEvent).toHaveBeenCalledTimes(1)
	})

	it('scopes dedup per event name so the same id fires each event once', () => {
		render(<Probe dedupKey="k1" eventName="comment_rendered" payload={{}} />)
		render(<Probe dedupKey="k1" eventName="notification_rendered" payload={{}} />)

		expect(trackEvent).toHaveBeenCalledTimes(2)
		expect(trackEvent.mock.calls[0][0]).toBe('comment_rendered')
		expect(trackEvent.mock.calls[1][0]).toBe('notification_rendered')
	})

	it('is a no-op when key stays null (actor never resolves)', () => {
		render(<Probe dedupKey={null} eventName="e" enabled={true} payload={{}} />)
		expect(trackEvent).not.toHaveBeenCalled()
	})
})
