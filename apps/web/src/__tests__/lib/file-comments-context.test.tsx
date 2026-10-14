import { FileCommentsProvider, useFileCommentsContext } from '@/lib/file-comments-context'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

// The client draft store is the seam the route wires to. These tests cover:
// - `roundId` is stable across draft additions on the same file.
// - `completeRound` mints a fresh `roundId` so a follow-up round doesn't
//   collide with the completed one (spec: "On next draft after Sent, generate
//   a fresh roundId").
// - Annotate mode toggles from the store; the Escape-key exit path used by
//   the route calls `exitAnnotateMode` and leaves other state alone.

function wrapper(seed?: () => string) {
	const factory: () => string = seed ?? (() => `id-${Math.random().toString(36).slice(2)}`)
	return function TestProvider({ children }: { children: React.ReactNode }) {
		return <FileCommentsProvider makeId={factory}>{children}</FileCommentsProvider>
	}
}

describe('FileCommentsProvider — draft store + roundId lifecycle', () => {
	it('every draft added shares the same roundId until completeRound fires', () => {
		let n = 0
		const seed = () => `id-${n++}`
		const { result } = renderHook(() => useFileCommentsContext(), {
			wrapper: wrapper(seed),
		})
		const initialRoundId = result.current.roundId
		act(() => {
			result.current.addDraft({ fileId: 'f1', page: 0, positionDoc: { x: 0.1, y: 0.1 } })
			result.current.addDraft({ fileId: 'f1', page: 0, positionDoc: { x: 0.2, y: 0.2 } })
		})
		expect(result.current.drafts).toHaveLength(2)
		expect(result.current.drafts.every((d) => d.roundId === initialRoundId)).toBe(true)
	})

	it('completeRound drops the posted drafts AND mints a fresh roundId', () => {
		let n = 0
		const seed = () => `id-${n++}`
		const { result } = renderHook(() => useFileCommentsContext(), {
			wrapper: wrapper(seed),
		})
		let posted = ''
		act(() => {
			const draft = result.current.addDraft({
				fileId: 'f1',
				page: 0,
				positionDoc: { x: 0.5, y: 0.5 },
			})
			posted = draft.tempId
		})
		const previousRoundId = result.current.roundId
		act(() => {
			result.current.completeRound([posted])
		})
		expect(result.current.drafts).toEqual([])
		expect(result.current.roundId).not.toBe(previousRoundId)
	})

	it('annotate mode toggles from the store and exitAnnotateMode leaves other state alone', () => {
		const { result } = renderHook(() => useFileCommentsContext(), {
			wrapper: wrapper(),
		})
		act(() => {
			result.current.setAnnotateMode(true)
			result.current.addDraft({
				fileId: 'f1',
				page: 0,
				positionDoc: { x: 0.5, y: 0.5 },
			})
		})
		expect(result.current.annotateMode).toBe(true)
		const draftsBefore = result.current.drafts
		act(() => {
			result.current.exitAnnotateMode()
		})
		expect(result.current.annotateMode).toBe(false)
		// Existing drafts survive an exit — the Esc key ends annotate mode
		// without discarding whatever the user already placed.
		expect(result.current.drafts).toEqual(draftsBefore)
	})
})
