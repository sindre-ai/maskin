import { useDocumentTitle } from '@/hooks/use-document-title'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('useDocumentTitle', () => {
	it('sets "<title> · Maskin" and follows title changes', () => {
		const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
			initialProps: { title: 'Roadmap' as string | undefined },
		})
		expect(document.title).toBe('Roadmap · Maskin')

		rerender({ title: 'Launch plan' })
		expect(document.title).toBe('Launch plan · Maskin')
	})

	it('falls back to Maskin Workspace while the title is not loaded', () => {
		renderHook(() => useDocumentTitle(undefined))
		expect(document.title).toBe('Maskin Workspace')
	})

	it('restores the fallback on unmount', () => {
		const { unmount } = renderHook(() => useDocumentTitle('Roadmap'))
		unmount()
		expect(document.title).toBe('Maskin Workspace')
	})
})
