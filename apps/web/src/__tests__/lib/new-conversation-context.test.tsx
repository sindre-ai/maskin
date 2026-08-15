import { NewConversationProvider, useNewConversationComposer } from '@/lib/new-conversation-context'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

function wrapper({ children }: { children: ReactNode }) {
	return <NewConversationProvider>{children}</NewConversationProvider>
}

describe('useNewConversationComposer', () => {
	it('throws when used outside a NewConversationProvider', () => {
		expect(() => renderHook(() => useNewConversationComposer())).toThrow(
			'useNewConversationComposer must be used within a NewConversationProvider',
		)
	})

	it('defaults to closed', () => {
		const { result } = renderHook(() => useNewConversationComposer(), { wrapper })
		expect(result.current.open).toBe(false)
	})

	it('setOpen updates open state, shared across consumers of the same provider', () => {
		const { result } = renderHook(() => useNewConversationComposer(), { wrapper })

		act(() => result.current.setOpen(true))
		expect(result.current.open).toBe(true)

		act(() => result.current.setOpen(false))
		expect(result.current.open).toBe(false)
	})
})
