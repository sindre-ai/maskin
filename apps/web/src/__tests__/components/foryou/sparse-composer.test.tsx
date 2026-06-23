import { SparseComposer } from '@/components/foryou/sparse-composer'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openWithContextMock = vi.fn()
const trackShownMock = vi.fn()
const trackSubmitMock = vi.fn()

vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ openWithContext: openWithContextMock }),
}))

vi.mock('@/lib/analytics', () => ({
	trackForyouSparseComposerShown: (p: { items_count: number }) => trackShownMock(p),
	trackForyouSparseComposerSubmit: (p: { items_count: number }) => trackSubmitMock(p),
}))

function getTextarea() {
	return screen.getByLabelText('Start a chat with agents') as HTMLTextAreaElement
}

describe('SparseComposer', () => {
	beforeEach(() => {
		openWithContextMock.mockReset()
		openWithContextMock.mockImplementation(() => undefined)
		trackShownMock.mockReset()
		trackSubmitMock.mockReset()
	})

	it('renders placeholder, input, and send button (AC-U1/AC-U2)', () => {
		render(<SparseComposer itemsCount={0} />)
		expect(screen.getByPlaceholderText('Ask agents to start something…')).toBeInTheDocument()
		expect(getTextarea()).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
	})

	it('shows quick-start chips only when itemsCount === 0', () => {
		const { rerender } = render(<SparseComposer itemsCount={0} />)
		expect(screen.getByTestId('sparse-composer-chips')).toBeInTheDocument()
		rerender(<SparseComposer itemsCount={2} />)
		expect(screen.queryByTestId('sparse-composer-chips')).not.toBeInTheDocument()
	})

	it('Enter submits via openWithContext and clears the input (AC-U4)', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.type(getTextarea(), 'help me plan a launch')
		await user.keyboard('{Enter}')
		await waitFor(() => {
			expect(openWithContextMock).toHaveBeenCalledTimes(1)
		})
		expect(openWithContextMock).toHaveBeenCalledWith([], 'help me plan a launch')
		await waitFor(() => expect(getTextarea().value).toBe(''))
	})

	it('clicking Send submits via openWithContext (AC-U4)', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={1} />)
		await user.type(getTextarea(), 'status of the rollout')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(openWithContextMock).toHaveBeenCalledWith([], 'status of the rollout')
		})
	})

	it('Shift+Enter inserts a newline and does not submit (AC-U6 parity)', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		const textarea = getTextarea()
		await user.type(textarea, 'line one')
		await user.keyboard('{Shift>}{Enter}{/Shift}')
		await user.type(textarea, 'line two')
		expect(textarea.value).toBe('line one\nline two')
		expect(openWithContextMock).not.toHaveBeenCalled()
	})

	it('IME composition swallows Enter (AC-U6 parity)', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		const textarea = getTextarea()
		await user.type(textarea, 'composing')
		// Simulate IME composition: keydown Enter with isComposing=true
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true,
		})
		Object.defineProperty(event, 'isComposing', { value: true })
		textarea.dispatchEvent(event)
		expect(openWithContextMock).not.toHaveBeenCalled()
	})

	it('clicking a quick-start chip submits its text via openWithContext', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.click(screen.getByRole('button', { name: 'What should I work on next?' }))
		await waitFor(() => {
			expect(openWithContextMock).toHaveBeenCalledWith([], 'What should I work on next?')
		})
	})

	it('fires foryou_sparse_composer_shown exactly once per mount with items_count (AC-T3)', () => {
		const { rerender } = render(<SparseComposer itemsCount={2} />)
		expect(trackShownMock).toHaveBeenCalledTimes(1)
		expect(trackShownMock).toHaveBeenCalledWith({ items_count: 2 })
		// Re-render without remount must not re-emit.
		rerender(<SparseComposer itemsCount={1} />)
		expect(trackShownMock).toHaveBeenCalledTimes(1)
	})

	it('emits foryou_sparse_composer_submit after openWithContext resolves with items_count snapshotted at submit (AC-U7, AC-T3)', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={2} />)
		await user.type(getTextarea(), 'go')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(trackSubmitMock).toHaveBeenCalledWith({ items_count: 2 })
		})
		expect(trackSubmitMock).toHaveBeenCalledTimes(1)
	})

	it('idempotent on rapid Enter/Send: at most one openWithContext + one _submit even with two presses (AC-T1)', async () => {
		const user = userEvent.setup()
		let resolve: () => void = () => {}
		openWithContextMock.mockImplementation(
			() =>
				new Promise<void>((r) => {
					resolve = r
				}),
		)
		render(<SparseComposer itemsCount={1} />)
		await user.type(getTextarea(), 'go')
		const sendBtn = screen.getByRole('button', { name: 'Send message' })
		await user.click(sendBtn)
		// Second click while the first is in-flight — button is disabled (no text yet
		// cleared either, but `sending` blocks the submit path).
		await user.click(sendBtn)
		expect(openWithContextMock).toHaveBeenCalledTimes(1)
		await act(async () => {
			resolve()
			await Promise.resolve()
		})
		await waitFor(() => {
			expect(trackSubmitMock).toHaveBeenCalledTimes(1)
		})
	})

	it('on openWithContext rejection: preserves input, shows error, does NOT emit _submit (AC-T2)', async () => {
		const user = userEvent.setup()
		openWithContextMock.mockImplementation(() => Promise.reject(new Error('sidebar offline')))
		render(<SparseComposer itemsCount={0} />)
		await user.type(getTextarea(), 'draft pitch')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(screen.getByRole('alert')).toHaveTextContent('sidebar offline')
		})
		expect(getTextarea().value).toBe('draft pitch')
		expect(trackSubmitMock).not.toHaveBeenCalled()
	})

	it('does not submit empty input (no whitespace-only submits)', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.type(getTextarea(), '   ')
		await user.keyboard('{Enter}')
		expect(openWithContextMock).not.toHaveBeenCalled()
	})
})
