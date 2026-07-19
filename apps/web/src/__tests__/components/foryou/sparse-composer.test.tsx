import type { ComposerProps } from '@/components/chat/chat'
import { SparseComposer } from '@/components/foryou/sparse-composer'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openWithContextMock = vi.fn()
const trackShownMock = vi.fn()
const trackSubmitMock = vi.fn()

vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ openWithContext: openWithContextMock }),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-test' }),
}))

vi.mock('@/lib/analytics', () => ({
	trackForyouSparseComposerShown: (p: { items_count: number }) => trackShownMock(p),
	trackForyouSparseComposerSubmit: (p: { items_count: number }) => trackSubmitMock(p),
}))

// Minimal stub — Composer's own tests cover its internals (Enter, error display, etc.).
// Exposes a hidden "Seed file attachment" button so tests can dispatch add_file into
// SparseComposer's reducer and assert the forwarding path through openWithContext.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		onSend,
		onDispatchSelection,
		placeholder,
		textareaLabel,
		disabled,
		externalError,
	}: ComposerProps) => {
		const [value, setValue] = useState('')
		return (
			<form
				onSubmit={(e) => {
					e.preventDefault()
					if (!value.trim()) return
					void onSend(value).then(
						() => setValue(''),
						() => {},
					)
				}}
			>
				<textarea
					placeholder={placeholder}
					aria-label={textareaLabel}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					disabled={disabled}
				/>
				<button type="submit" aria-label="Send message" disabled={disabled || !value.trim()} />
				<button
					type="button"
					aria-label="Seed file attachment"
					onClick={() =>
						onDispatchSelection?.({
							type: 'add_file',
							file: {
								fileId: 'file-seeded',
								name: 'photo.jpg',
								sizeBytes: 2048,
								mimeType: 'image/jpeg',
							},
						})
					}
				/>
				{externalError ? <p role="alert">{externalError}</p> : null}
			</form>
		)
	},
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

	it('renders placeholder and send button', () => {
		render(<SparseComposer itemsCount={0} />)
		expect(screen.getByPlaceholderText('Ask agents to start something…')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
	})

	it('shows quick-start chips only when itemsCount === 0', () => {
		const { rerender } = render(<SparseComposer itemsCount={0} />)
		expect(screen.getByTestId('sparse-composer-chips')).toBeInTheDocument()
		rerender(<SparseComposer itemsCount={2} />)
		expect(screen.queryByTestId('sparse-composer-chips')).not.toBeInTheDocument()
	})

	it('submits via openWithContext with empty attachments and clears the input', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.type(getTextarea(), 'help me plan a launch')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(openWithContextMock).toHaveBeenCalledWith([], 'help me plan a launch')
		})
		await waitFor(() => expect(getTextarea().value).toBe(''))
	})

	it('clicking a quick-start chip submits its text via openWithContext', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.click(screen.getByRole('button', { name: 'Help me plan a new bet' }))
		await waitFor(() => {
			expect(openWithContextMock).toHaveBeenCalledWith([], 'Help me plan a new bet')
		})
	})

	it('fires foryou_sparse_composer_shown exactly once per mount with items_count', () => {
		const { rerender } = render(<SparseComposer itemsCount={2} />)
		expect(trackShownMock).toHaveBeenCalledTimes(1)
		expect(trackShownMock).toHaveBeenCalledWith({ items_count: 2 })
		rerender(<SparseComposer itemsCount={1} />)
		expect(trackShownMock).toHaveBeenCalledTimes(1)
	})

	it('emits foryou_sparse_composer_submit after openWithContext resolves with items_count snapshotted at submit', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={2} />)
		await user.type(getTextarea(), 'go')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(trackSubmitMock).toHaveBeenCalledWith({ items_count: 2 })
		})
		expect(trackSubmitMock).toHaveBeenCalledTimes(1)
	})

	it('does not submit empty input', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.type(getTextarea(), '   ')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		expect(openWithContextMock).not.toHaveBeenCalled()
	})

	it('does not emit _submit and preserves draft when openWithContext rejects via Composer submit (AC-T2/T3)', async () => {
		openWithContextMock.mockRejectedValue(new Error('network error'))
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={2} />)
		await user.type(getTextarea(), 'test message')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => expect(openWithContextMock).toHaveBeenCalled())
		expect(trackSubmitMock).not.toHaveBeenCalled()
		expect(getTextarea().value).toBe('test message')
	})

	it('chip double-tap is idempotent — second click ignored while first is in-flight (AC-T1)', async () => {
		let resolve!: () => void
		openWithContextMock.mockReturnValue(
			new Promise<void>((r) => {
				resolve = r
			}),
		)
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		const chip = screen.getByRole('button', { name: 'Help me plan a new bet' })
		await user.click(chip)
		await user.click(chip)
		resolve()
		await waitFor(() => expect(openWithContextMock).toHaveBeenCalledTimes(1))
	})

	it('does not emit _submit and re-enables chip when openWithContext rejects via chip click (AC-T2/T3)', async () => {
		openWithContextMock.mockRejectedValue(new Error('sidebar error'))
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		const chip = screen.getByRole('button', { name: 'Help me plan a new bet' })
		await user.click(chip)
		await waitFor(() => expect(openWithContextMock).toHaveBeenCalled())
		expect(trackSubmitMock).not.toHaveBeenCalled()
		await waitFor(() => expect(chip).not.toBeDisabled())
	})

	it('forwards a picked file attachment to the sheet so Chat.handleSend sees it on the auto-send turn', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.click(screen.getByRole('button', { name: 'Seed file attachment' }))
		await user.type(getTextarea(), 'look at this')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(openWithContextMock).toHaveBeenCalledWith(
				[
					{
						kind: 'file',
						fileId: 'file-seeded',
						name: 'photo.jpg',
						sizeBytes: 2048,
						mimeType: 'image/jpeg',
					},
				],
				'look at this',
			)
		})
	})

	it('clears chipError on successful text-input submit after a prior chip failure', async () => {
		openWithContextMock.mockRejectedValueOnce(new Error('sidebar error'))
		openWithContextMock.mockResolvedValue(undefined)
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		// Trigger a chip error.
		await user.click(screen.getByRole('button', { name: 'Help me plan a new bet' }))
		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
		// Successful text-input submit should clear the error.
		await user.type(getTextarea(), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => expect(openWithContextMock).toHaveBeenCalledTimes(2))
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})
})
