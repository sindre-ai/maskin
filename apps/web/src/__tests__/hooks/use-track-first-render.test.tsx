import {
	__resetFirstRenderTrackerForTesting,
	useTrackFirstRender,
} from '@/hooks/use-track-first-render'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `key` is a reserved React prop (consumed by reconciliation), so this probe
// takes `dedupKey` instead and forwards it to the hook — otherwise the test
// would silently pass undefined into the hook.
function Probe(props: {
	dedupKey: string | null | undefined
	eventName: string
	enabled?: boolean
	fire: () => void
}) {
	useTrackFirstRender({
		key: props.dedupKey,
		eventName: props.eventName,
		enabled: props.enabled,
		fire: props.fire,
	})
	return null
}

beforeEach(() => {
	__resetFirstRenderTrackerForTesting()
})

afterEach(() => {
	__resetFirstRenderTrackerForTesting()
})

describe('useTrackFirstRender', () => {
	it('invokes fire once when key + enabled resolve on mount', () => {
		const fire = vi.fn()
		render(<Probe dedupKey="k1" eventName="comment_rendered" fire={fire} />)

		expect(fire).toHaveBeenCalledTimes(1)
	})

	it('does not re-invoke fire on re-render of the same key', () => {
		const fire = vi.fn()
		const { rerender } = render(<Probe dedupKey="k1" eventName="e" fire={fire} />)
		rerender(<Probe dedupKey="k1" eventName="e" fire={fire} />)
		rerender(<Probe dedupKey="k1" eventName="e" fire={fire} />)

		expect(fire).toHaveBeenCalledTimes(1)
	})

	it('does not fire until enabled flips true (deferred until actor loads)', () => {
		const fire = vi.fn()
		const { rerender } = render(<Probe dedupKey={null} eventName="e" enabled={false} fire={fire} />)
		expect(fire).not.toHaveBeenCalled()

		rerender(<Probe dedupKey="k1" eventName="e" enabled={true} fire={fire} />)
		expect(fire).toHaveBeenCalledTimes(1)
	})

	it('dedupes across unmount + remount (virtualization scroll)', () => {
		const fire = vi.fn()
		const { unmount } = render(<Probe dedupKey="k1" eventName="e" fire={fire} />)
		expect(fire).toHaveBeenCalledTimes(1)
		unmount()

		render(<Probe dedupKey="k1" eventName="e" fire={fire} />)
		expect(fire).toHaveBeenCalledTimes(1)
	})

	it('scopes dedup per event name so the same id fires each event once', () => {
		const commentFire = vi.fn()
		const notificationFire = vi.fn()
		render(<Probe dedupKey="k1" eventName="comment_rendered" fire={commentFire} />)
		render(<Probe dedupKey="k1" eventName="notification_rendered" fire={notificationFire} />)

		expect(commentFire).toHaveBeenCalledTimes(1)
		expect(notificationFire).toHaveBeenCalledTimes(1)
	})

	it('is a no-op when key stays null (actor never resolves)', () => {
		const fire = vi.fn()
		render(<Probe dedupKey={null} eventName="e" enabled={true} fire={fire} />)
		expect(fire).not.toHaveBeenCalled()
	})
})
