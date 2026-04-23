import { SindreProvider, useSindre } from '@/lib/sindre-context'
import { act, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const WORKSPACE_A = 'ws-aaa'
const WORKSPACE_B = 'ws-bbb'

function makeWrapper(workspaceId: string) {
	return ({ children }: { children: ReactNode }) => (
		<SindreProvider workspaceId={workspaceId}>{children}</SindreProvider>
	)
}

describe('useSindre', () => {
	beforeEach(() => {
		localStorage.clear()
	})

	afterEach(() => {
		localStorage.clear()
	})

	it('throws when used outside a SindreProvider', () => {
		expect(() => renderHook(() => useSindre())).toThrow(
			'useSindre must be used within a SindreProvider',
		)
	})

	it('defaults to closed with no attachments', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })
		expect(result.current.open).toBe(false)
		expect(result.current.pendingAttachments).toEqual([])
		expect(result.current.pendingMessage).toBeNull()
	})

	it('setOpen accepts both a boolean and an updater function', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => result.current.setOpen(true))
		expect(result.current.open).toBe(true)

		act(() => result.current.setOpen((prev) => !prev))
		expect(result.current.open).toBe(false)
	})

	it('openWithContext stages attachments and opens the sheet', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => {
			result.current.openWithContext([
				{ kind: 'object', id: 'obj-1', title: 'Bet: ship Sindre', type: 'bet' },
				{ kind: 'notification', id: 'notif-1', title: 'New comment' },
			])
		})

		expect(result.current.open).toBe(true)
		expect(result.current.pendingAttachments).toEqual([
			{ kind: 'object', id: 'obj-1', title: 'Bet: ship Sindre', type: 'bet' },
			{ kind: 'notification', id: 'notif-1', title: 'New comment' },
		])
	})

	it('clearPendingAttachments drops staged attachments without closing the sheet', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => {
			result.current.openWithContext([{ kind: 'object', id: 'obj-1' }])
		})
		act(() => {
			result.current.clearPendingAttachments()
		})

		expect(result.current.open).toBe(true)
		expect(result.current.pendingAttachments).toEqual([])
	})

	it('openWithContext stages a pending message when the optional arg is passed', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => {
			result.current.openWithContext(
				[{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' }],
				'hello sindre',
			)
		})

		expect(result.current.open).toBe(true)
		expect(result.current.pendingMessage).toBe('hello sindre')
		expect(result.current.pendingAttachments).toEqual([
			{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
		])
	})

	it('openWithContext leaves pendingMessage null when no message is passed', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => {
			result.current.openWithContext([{ kind: 'object', id: 'obj-1' }])
		})

		expect(result.current.pendingMessage).toBeNull()
	})

	it('openWithContext normalizes an empty string to null', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => {
			result.current.openWithContext([], '')
		})

		expect(result.current.pendingMessage).toBeNull()
	})

	it('clearPendingMessage drops the staged message without closing the sheet', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		act(() => {
			result.current.openWithContext([], 'queued')
		})
		expect(result.current.pendingMessage).toBe('queued')

		act(() => {
			result.current.clearPendingMessage()
		})

		expect(result.current.open).toBe(true)
		expect(result.current.pendingMessage).toBeNull()
	})

	it('resets open state and attachments when workspace changes', () => {
		let captured: ReturnType<typeof useSindre> | null = null
		function Consumer() {
			captured = useSindre()
			return null
		}

		function getCaptured(): ReturnType<typeof useSindre> {
			if (!captured) throw new Error('SindreProvider did not render Consumer')
			return captured
		}

		const { rerender } = render(
			<SindreProvider workspaceId={WORKSPACE_A}>
				<Consumer />
			</SindreProvider>,
		)

		act(() => {
			getCaptured().openWithContext([{ kind: 'object', id: 'obj-1' }])
		})
		expect(getCaptured().open).toBe(true)
		expect(getCaptured().pendingAttachments).toHaveLength(1)

		rerender(
			<SindreProvider workspaceId={WORKSPACE_B}>
				<Consumer />
			</SindreProvider>,
		)

		expect(getCaptured().open).toBe(false)
		expect(getCaptured().pendingAttachments).toEqual([])
	})

	it('returns stable callback references across state changes', () => {
		const { result } = renderHook(() => useSindre(), { wrapper: makeWrapper(WORKSPACE_A) })

		const first = {
			setOpen: result.current.setOpen,
			openWithContext: result.current.openWithContext,
			clearPendingAttachments: result.current.clearPendingAttachments,
			clearPendingMessage: result.current.clearPendingMessage,
		}

		act(() => result.current.setOpen(true))

		expect(result.current.setOpen).toBe(first.setOpen)
		expect(result.current.openWithContext).toBe(first.openWithContext)
		expect(result.current.clearPendingAttachments).toBe(first.clearPendingAttachments)
		expect(result.current.clearPendingMessage).toBe(first.clearPendingMessage)
	})
})
