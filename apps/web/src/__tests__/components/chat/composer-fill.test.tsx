import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-files', () => ({ useUploadFile: () => vi.fn() }))
vi.mock('@/lib/file-utils', () => ({ readFileAsBase64: async () => 'AAAA' }))
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
}))

type FillRequest = { text?: string; nonce: number } | null

function composer(fillRequest: FillRequest, draftKey = 'conv-1') {
	return (
		<Composer
			workspaceId="ws-test"
			onSend={vi.fn().mockResolvedValue(undefined)}
			disabled={false}
			pending={false}
			surface="sheet"
			placeholder="Message"
			selection={EMPTY_CHAT_SELECTION}
			onDispatchSelection={vi.fn()}
			onRemoveAgent={vi.fn()}
			onRemoveObject={vi.fn()}
			onRemoveNotification={vi.fn()}
			onRemoveFile={vi.fn()}
			draftKey={draftKey}
			fillRequest={fillRequest}
		/>
	)
}

describe('Composer fillRequest', () => {
	beforeEach(() => {
		sessionStorage.clear()
		// Run animation frames synchronously so the focus step is observable.
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0)
			return 0
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('replaces the draft, mirrors it to the stored draft, and focuses with the caret at the end', async () => {
		const wrapper = createWorkspaceWrapper()
		const { rerender } = render(composer(null), { wrapper })
		const box = screen.getByRole('textbox')
		await userEvent.type(box, 'half a sentence')

		rerender(composer({ text: 'Here is a first task for you: ', nonce: 1 }))

		const text = 'Here is a first task for you: '
		expect(box).toHaveValue(text)
		expect(sessionStorage.getItem('composer-draft:conv-1')).toBe(text)
		expect(box).toHaveFocus()
		expect((box as HTMLTextAreaElement).selectionStart).toBe(text.length)
		expect((box as HTMLTextAreaElement).selectionEnd).toBe(text.length)
	})

	it('fills again for a new nonce, replacing the earlier fill', () => {
		const wrapper = createWorkspaceWrapper()
		const { rerender } = render(composer({ text: 'First', nonce: 1 }), { wrapper })
		rerender(composer({ text: 'First', nonce: 2 }))
		rerender(composer({ text: 'Second', nonce: 3 }))

		expect(screen.getByRole('textbox')).toHaveValue('Second')
	})

	it('only focuses, with the caret at the end, when the request carries no text', async () => {
		const wrapper = createWorkspaceWrapper()
		const { rerender } = render(composer(null), { wrapper })
		const box = screen.getByRole('textbox')
		await userEvent.type(box, 'my draft')
		box.blur()

		rerender(composer({ nonce: 1 }))

		expect(box).toHaveValue('my draft')
		expect(box).toHaveFocus()
		expect((box as HTMLTextAreaElement).selectionStart).toBe('my draft'.length)
	})

	it('ignores a request that was already there when the composer mounted', () => {
		render(composer({ text: 'Stale', nonce: 7 }), { wrapper: createWorkspaceWrapper() })

		expect(screen.getByRole('textbox')).toHaveValue('')
	})

	it('does not fill twice for the same nonce after the user edited the draft', async () => {
		const wrapper = createWorkspaceWrapper()
		const { rerender } = render(composer(null), { wrapper })
		rerender(composer({ text: 'Fill', nonce: 1 }))
		await userEvent.type(screen.getByRole('textbox'), ' more')

		await act(async () => {
			rerender(composer({ text: 'Fill', nonce: 1 }))
		})

		expect(screen.getByRole('textbox')).toHaveValue('Fill more')
	})
})
