import { render } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseEntityEvents = vi.fn()
const mockGetStoredActor = vi.fn()

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: (...args: unknown[]) => mockUseEntityEvents(...args),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => mockGetStoredActor(),
}))

import { useEntityThread, type UseEntityThreadResult } from '@/hooks/use-entity-thread'
import { buildEventResponse } from '../factories'
import { TestWrapper } from '../setup'

function Harness({
	unreadCount,
	onResult,
}: {
	unreadCount: number
	onResult: (result: UseEntityThreadResult) => void
}) {
	const result = useEntityThread('ws-1', 'obj-1', unreadCount)
	onResult(result)
	return React.createElement('div', {
		ref: result.containerRef,
		'data-testid': 'thread-container',
	})
}

function renderHarness(unreadCount: number): { current: UseEntityThreadResult | undefined } {
	const box: { current: UseEntityThreadResult | undefined } = { current: undefined }
	render(
		React.createElement(
			TestWrapper,
			null,
			React.createElement(Harness, {
				unreadCount,
				onResult: (r: UseEntityThreadResult) => {
					box.current = r
				},
			}),
		),
	)
	return box
}

// Fires isIntersecting synchronously on observe() so hasBeenVisible flips true.
class EagerObserver {
	private callback: IntersectionObserverCallback
	constructor(cb: IntersectionObserverCallback) {
		this.callback = cb
	}
	observe(target: Element) {
		this.callback(
			[{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		)
	}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return []
	}
}

describe('useEntityThread', () => {
	const originalIntersectionObserver = globalThis.IntersectionObserver

	beforeEach(() => {
		mockUseEntityEvents.mockReset()
		mockUseEntityEvents.mockReturnValue({ data: undefined })
		mockGetStoredActor.mockReset()
		mockGetStoredActor.mockReturnValue({
			id: 'viewer',
			name: 'Viewer',
			type: 'human',
			email: null,
		})
	})

	afterEach(() => {
		globalThis.IntersectionObserver = originalIntersectionObserver
	})

	it('gates the events query behind visibility, passing enabled: false before intersection', () => {
		const box = renderHarness(1)
		expect(mockUseEntityEvents).toHaveBeenCalledWith('ws-1', 'obj-1', { enabled: false })
		expect(box.current?.hasBeenVisible).toBe(false)
	})

	it('flips hasBeenVisible and re-queries with enabled: true once the container intersects', () => {
		globalThis.IntersectionObserver = EagerObserver as unknown as typeof IntersectionObserver
		const box = renderHarness(1)
		expect(box.current?.hasBeenVisible).toBe(true)
		expect(mockUseEntityEvents).toHaveBeenLastCalledWith('ws-1', 'obj-1', { enabled: true })
	})

	it('returns empty defaults when events is undefined', () => {
		mockUseEntityEvents.mockReturnValue({ data: undefined })
		const box = renderHarness(1)
		expect(box.current?.nodes).toEqual([])
		expect(box.current?.firstUnreadRootId).toBeNull()
		expect(box.current?.firstUnreadEventId).toBeNull()
		expect(box.current?.latestRootId).toBeNull()
		expect(box.current?.latestEventId).toBe(0)
	})

	it('builds a root/reply tree from flat comment events, grouping replies under their parent root', () => {
		const root1 = buildEventResponse({
			id: 10,
			action: 'commented',
			actorId: 'other',
			data: {},
		})
		const reply1 = buildEventResponse({
			id: 20,
			action: 'commented',
			actorId: 'other',
			data: { parentEventId: 10 },
		})
		const root2 = buildEventResponse({
			id: 30,
			action: 'commented',
			actorId: 'other',
			data: {},
		})
		// The API returns events newest-first.
		mockUseEntityEvents.mockReturnValue({ data: [root2, reply1, root1] })
		const box = renderHarness(0)

		expect(box.current?.nodes).toHaveLength(2)
		expect(box.current?.nodes[0]?.root.id).toBe(10)
		expect(box.current?.nodes[0]?.replies.map((e) => e.id)).toEqual([20])
		expect(box.current?.nodes[1]?.root.id).toBe(30)
		expect(box.current?.nodes[1]?.replies).toEqual([])
	})

	it('ignores events whose action is not "commented"', () => {
		const created = buildEventResponse({ id: 5, action: 'created', actorId: 'other' })
		const comment = buildEventResponse({
			id: 6,
			action: 'commented',
			actorId: 'other',
			data: {},
		})
		mockUseEntityEvents.mockReturnValue({ data: [comment, created] })
		const box = renderHarness(0)

		expect(box.current?.nodes).toHaveLength(1)
		expect(box.current?.nodes[0]?.root.id).toBe(6)
	})

	it('computes the unread boundary by counting non-viewer comments back from the newest', () => {
		const root1 = buildEventResponse({ id: 1, action: 'commented', actorId: 'other', data: {} })
		const root2 = buildEventResponse({ id: 2, action: 'commented', actorId: 'other', data: {} })
		const root3 = buildEventResponse({ id: 3, action: 'commented', actorId: 'other', data: {} })
		mockUseEntityEvents.mockReturnValue({ data: [root3, root2, root1] })
		const box = renderHarness(2)

		// Walking back from the newest (root3), counting 2: root3 (1), root2 (2) — boundary at root2.
		expect(box.current?.firstUnreadRootId).toBe(2)
		expect(box.current?.firstUnreadEventId).toBe(2)
	})

	it("skips the viewer's own comments when counting unread", () => {
		const root1 = buildEventResponse({ id: 1, action: 'commented', actorId: 'other', data: {} })
		const viewerRoot = buildEventResponse({
			id: 2,
			action: 'commented',
			actorId: 'viewer',
			data: {},
		})
		const root3 = buildEventResponse({ id: 3, action: 'commented', actorId: 'other', data: {} })
		mockUseEntityEvents.mockReturnValue({ data: [root3, viewerRoot, root1] })
		const box = renderHarness(2)

		// root3 counts (1), viewerRoot is skipped, root1 counts (2) — boundary at root1.
		expect(box.current?.firstUnreadRootId).toBe(1)
		expect(box.current?.firstUnreadEventId).toBe(1)
	})

	it('falls back to the oldest loaded non-viewer comment when unreadCount exceeds the loaded window', () => {
		const root1 = buildEventResponse({ id: 1, action: 'commented', actorId: 'other', data: {} })
		const root2 = buildEventResponse({ id: 2, action: 'commented', actorId: 'other', data: {} })
		mockUseEntityEvents.mockReturnValue({ data: [root2, root1] })
		const box = renderHarness(10)

		expect(box.current?.firstUnreadRootId).toBe(1)
		expect(box.current?.firstUnreadEventId).toBe(1)
	})

	it('returns null boundaries when unreadCount is 0', () => {
		const root1 = buildEventResponse({ id: 1, action: 'commented', actorId: 'other', data: {} })
		mockUseEntityEvents.mockReturnValue({ data: [root1] })
		const box = renderHarness(0)

		expect(box.current?.firstUnreadRootId).toBeNull()
		expect(box.current?.firstUnreadEventId).toBeNull()
	})

	it('computes latestRootId and latestEventId as the max ids across all nodes, including replies', () => {
		const root1 = buildEventResponse({ id: 1, action: 'commented', actorId: 'other', data: {} })
		const reply1 = buildEventResponse({
			id: 50,
			action: 'commented',
			actorId: 'other',
			data: { parentEventId: 1 },
		})
		mockUseEntityEvents.mockReturnValue({ data: [reply1, root1] })
		const box = renderHarness(0)

		expect(box.current?.latestRootId).toBe(1)
		expect(box.current?.latestEventId).toBe(50)
	})
})
