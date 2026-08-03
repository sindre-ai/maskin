import {
	isForYouEntryPath,
	useFypSessionOpenedEvent,
	useFypWorkspaceMountEvents,
} from '@/hooks/use-fyp-session'
import { __setInitializedForTesting } from '@/lib/posthog'
import { renderHook } from '@testing-library/react'
import posthog from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	sessionStorage.clear()
	__setInitializedForTesting(true)
})

afterEach(() => {
	__setInitializedForTesting(false)
	vi.restoreAllMocks()
	sessionStorage.clear()
})

describe('isForYouEntryPath', () => {
	it('matches the workspace root only', () => {
		expect(isForYouEntryPath('/ws-1', 'ws-1')).toBe(true)
		expect(isForYouEntryPath('/ws-1/', 'ws-1')).toBe(true)
		expect(isForYouEntryPath('/ws-1/objects', 'ws-1')).toBe(false)
		expect(isForYouEntryPath('/other-ws', 'ws-1')).toBe(false)
		expect(isForYouEntryPath('/', 'ws-1')).toBe(false)
	})
})

describe('useFypWorkspaceMountEvents', () => {
	function setPathname(path: string) {
		window.history.replaceState({}, '', path)
	}

	it('fires workspace_session_start once per session and fyp_opened_first when entry is For You', () => {
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		setPathname('/ws-1')

		const { rerender } = renderHook(({ id }) => useFypWorkspaceMountEvents(id), {
			initialProps: { id: 'ws-1' },
		})

		const first = capture.mock.calls.map(([name]) => name)
		expect(first).toContain('workspace_session_start')
		expect(first).toContain('fyp_opened_first')

		// A re-render or a re-mount within the same tab session must not re-fire.
		capture.mockClear()
		rerender({ id: 'ws-1' })
		expect(capture).not.toHaveBeenCalled()
	})

	it('does NOT fire fyp_opened_first when the entry surface is not For You', () => {
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		setPathname('/ws-1/objects')

		renderHook(() => useFypWorkspaceMountEvents('ws-1'))

		const names = capture.mock.calls.map(([name]) => name)
		expect(names).toContain('workspace_session_start')
		expect(names).not.toContain('fyp_opened_first')
	})
})

describe('useFypSessionOpenedEvent', () => {
	it('fires fyp_session_opened at most once per session', () => {
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)

		const first = renderHook(() => useFypSessionOpenedEvent('ws-1'))
		first.unmount()
		const second = renderHook(() => useFypSessionOpenedEvent('ws-1'))
		second.rerender()

		const opens = capture.mock.calls.filter(([name]) => name === 'fyp_session_opened')
		expect(opens).toHaveLength(1)
		expect(opens[0][1]).toEqual({ workspace_id: 'ws-1' })
	})
})
