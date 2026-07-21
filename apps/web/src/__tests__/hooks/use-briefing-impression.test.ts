import { useBriefingImpression } from '@/hooks/use-briefing-impression'
import { __setInitializedForTesting } from '@/lib/posthog'
import { renderHook } from '@testing-library/react'
import posthog from 'posthog-js'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IOStub = {
	observe: ReturnType<typeof vi.fn>
	unobserve: ReturnType<typeof vi.fn>
	disconnect: ReturnType<typeof vi.fn>
	takeRecords: ReturnType<typeof vi.fn>
	trigger: (isIntersecting: boolean) => void
}

// Replaces the setup.ts stub with a version that records the callback so tests
// can drive intersection state manually.
function installIntersectionObserverStub(): IOStub {
	let cb: IntersectionObserverCallback | null = null
	const stub = {
		observe: vi.fn(),
		unobserve: vi.fn(),
		disconnect: vi.fn(),
		takeRecords: vi.fn(() => []),
		trigger(isIntersecting: boolean) {
			cb?.(
				[{ isIntersecting } as IntersectionObserverEntry],
				stub as unknown as IntersectionObserver,
			)
		},
	}
	globalThis.IntersectionObserver = vi.fn().mockImplementation((callback) => {
		cb = callback
		return stub
	}) as unknown as typeof IntersectionObserver
	return stub as unknown as IOStub
}

beforeEach(() => {
	sessionStorage.clear()
	__setInitializedForTesting(true)
})

afterEach(() => {
	__setInitializedForTesting(false)
	vi.restoreAllMocks()
	sessionStorage.clear()
})

describe('useBriefingImpression — scroll >50%', () => {
	it('fires fyp_briefing_read when the midpoint sentinel intersects the viewport, once', () => {
		const io = installIntersectionObserverStub()
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)

		const body = document.createElement('div')
		const bodyRef = { current: body } as RefObject<HTMLDivElement>

		renderHook(() =>
			useBriefingImpression({
				workspaceId: 'ws-1',
				briefingId: 'brief-1',
				bodyRef,
				audioEl: null,
			}),
		)

		io.trigger(true)
		io.trigger(true)

		const readCalls = capture.mock.calls.filter(([name]) => name === 'fyp_briefing_read')
		expect(readCalls).toHaveLength(1)
		expect(readCalls[0][1]).toEqual({ workspace_id: 'ws-1', briefing_id: 'brief-1' })
	})

	it('does not fire when briefingId is null', () => {
		installIntersectionObserverStub()
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)

		const body = document.createElement('div')
		const bodyRef = { current: body } as RefObject<HTMLDivElement>

		renderHook(() =>
			useBriefingImpression({
				workspaceId: 'ws-1',
				briefingId: null,
				bodyRef,
				audioEl: null,
			}),
		)

		expect(capture).not.toHaveBeenCalled()
	})
})

describe('useBriefingImpression — audio >60s', () => {
	function makeAudioEl() {
		const listeners: Array<() => void> = []
		const el = {
			currentTime: 0,
			addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
			removeEventListener: (_type: string, fn: () => void) => {
				const idx = listeners.indexOf(fn)
				if (idx >= 0) listeners.splice(idx, 1)
			},
			tick(seconds: number) {
				el.currentTime = seconds
				for (const l of [...listeners]) l()
			},
		}
		return el
	}

	it('fires fyp_briefing_audio_played the first time currentTime crosses 60, dedupes on re-emit', () => {
		installIntersectionObserverStub()
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		const audio = makeAudioEl()

		renderHook(() =>
			useBriefingImpression({
				workspaceId: 'ws-1',
				briefingId: 'brief-1',
				bodyRef: { current: null } as unknown as RefObject<HTMLElement>,
				audioEl: audio as unknown as HTMLAudioElement,
			}),
		)

		audio.tick(30) // under threshold — no event
		audio.tick(60.1) // crosses — fire once
		audio.tick(75) // still over threshold — dedupe

		const audioCalls = capture.mock.calls.filter(([name]) => name === 'fyp_briefing_audio_played')
		expect(audioCalls).toHaveLength(1)
		expect(audioCalls[0][1]).toEqual({ workspace_id: 'ws-1', briefing_id: 'brief-1' })
	})
})
