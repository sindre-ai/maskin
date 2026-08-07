import type { ComposerProps } from '@/components/chat/chat'
import { SparseComposer } from '@/components/foryou/sparse-composer'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createConversationMock = vi.fn()
const navigateMock = vi.fn()
const trackShownMock = vi.fn()
const trackSubmitMock = vi.fn()

vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: createConversationMock }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => ({ id: 'agent-coach', name: 'Workspace Coach' }),
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-test', workspace: { id: 'ws-test', settings: {} } }),
}))

vi.mock('@/lib/analytics', () => ({
	trackForyouSparseComposerShown: (p: { items_count: number }) => trackShownMock(p),
	trackForyouSparseComposerSubmit: (p: { items_count: number }) => trackSubmitMock(p),
}))

// Minimal stub — Composer's own tests cover its internals (Enter, error display, etc.).
// Exposes a hidden "Seed file attachment" button so tests can dispatch add_file into
// SparseComposer's reducer and assert the forwarding path through the composer's onSend.
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
		createConversationMock.mockReset()
		createConversationMock.mockResolvedValue({ id: 'conv-1' })
		navigateMock.mockReset()
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

	it('creates a conversation with the default agent, navigates to it, and clears the input', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.type(getTextarea(), 'help me plan a launch')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(createConversationMock).toHaveBeenCalledWith({
				title: 'Workspace Coach',
				participant_actor_ids: ['agent-coach'],
				initial_message: 'help me plan a launch',
			})
		})
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId: 'ws-test', conversationId: 'conv-1' },
			}),
		)
		await waitFor(() => expect(getTextarea().value).toBe(''))
	})

	it('clicking a quick-start chip submits its text via createConversation', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.click(screen.getByRole('button', { name: 'Help me plan a new bet' }))
		await waitFor(() => {
			expect(createConversationMock).toHaveBeenCalledWith(
				expect.objectContaining({ initial_message: 'Help me plan a new bet' }),
			)
		})
	})

	it('fires foryou_sparse_composer_shown exactly once per mount with items_count', () => {
		const { rerender } = render(<SparseComposer itemsCount={2} />)
		expect(trackShownMock).toHaveBeenCalledTimes(1)
		expect(trackShownMock).toHaveBeenCalledWith({ items_count: 2 })
		rerender(<SparseComposer itemsCount={1} />)
		expect(trackShownMock).toHaveBeenCalledTimes(1)
	})

	it('emits foryou_sparse_composer_submit after createConversation resolves with items_count snapshotted at submit', async () => {
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
		expect(createConversationMock).not.toHaveBeenCalled()
	})

	it('does not emit _submit and preserves draft when createConversation rejects via Composer submit (AC-T2/T3)', async () => {
		createConversationMock.mockRejectedValue(new Error('network error'))
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={2} />)
		await user.type(getTextarea(), 'test message')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => expect(createConversationMock).toHaveBeenCalled())
		expect(trackSubmitMock).not.toHaveBeenCalled()
		expect(getTextarea().value).toBe('test message')
	})

	it('chip double-tap is idempotent — second click ignored while first is in-flight (AC-T1)', async () => {
		let resolve!: (value: { id: string }) => void
		createConversationMock.mockReturnValue(
			new Promise<{ id: string }>((r) => {
				resolve = r
			}),
		)
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		const chip = screen.getByRole('button', { name: 'Help me plan a new bet' })
		await user.click(chip)
		await user.click(chip)
		resolve({ id: 'conv-1' })
		await waitFor(() => expect(createConversationMock).toHaveBeenCalledTimes(1))
	})

	it('does not emit _submit and re-enables chip when createConversation rejects via chip click (AC-T2/T3)', async () => {
		createConversationMock.mockRejectedValue(new Error('sidebar error'))
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		const chip = screen.getByRole('button', { name: 'Help me plan a new bet' })
		await user.click(chip)
		await waitFor(() => expect(createConversationMock).toHaveBeenCalled())
		expect(trackSubmitMock).not.toHaveBeenCalled()
		await waitFor(() => expect(chip).not.toBeDisabled())
	})

	it('forwards a picked file attachment into the initial message so the thread sees it', async () => {
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		await user.click(screen.getByRole('button', { name: 'Seed file attachment' }))
		await user.type(getTextarea(), 'look at this')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => {
			expect(createConversationMock).toHaveBeenCalledWith(
				expect.objectContaining({
					initial_message: expect.stringContaining('photo.jpg'),
				}),
			)
		})
	})

	it('shifts up via translateY while focused when the visual viewport shrinks (soft keyboard)', async () => {
		const user = userEvent.setup()
		const originalVisualViewport = window.visualViewport
		const listeners: Record<string, () => void> = {}
		const vv = {
			height: 667,
			offsetTop: 0,
			addEventListener: (type: string, cb: () => void) => {
				listeners[type] = cb
			},
			removeEventListener: vi.fn(),
		}
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 })

		const { container } = render(<SparseComposer itemsCount={0} />)
		const wrapper = container.firstElementChild as HTMLElement
		await user.click(getTextarea())
		expect(wrapper.style.transform).toBe('')

		vv.height = 377
		act(() => listeners.resize?.())
		await waitFor(() => expect(wrapper.style.transform).toBe('translateY(-290px)'))

		// Keyboard-down: viewport restored, shift is removed.
		vv.height = 667
		act(() => listeners.resize?.())
		await waitFor(() => expect(wrapper.style.transform).toBe(''))

		Object.defineProperty(window, 'visualViewport', {
			configurable: true,
			value: originalVisualViewport,
		})
	})

	it('applies the shift when a resize event fires immediately after focus, before any render gap (regression: listener must be attached at mount, not after the focus re-render)', async () => {
		const originalVisualViewport = window.visualViewport
		const listeners: Record<string, () => void> = {}
		const vv = {
			height: 667,
			offsetTop: 0,
			addEventListener: (type: string, cb: () => void) => {
				listeners[type] = cb
			},
			removeEventListener: vi.fn(),
		}
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 })

		const { container } = render(<SparseComposer itemsCount={0} />)
		const wrapper = container.firstElementChild as HTMLElement

		// Fire focus and the resize event back-to-back with no intervening
		// await — mirrors a real browser dispatching a keyboard-open resize
		// before React has re-rendered from the focus state update.
		fireEvent.focus(getTextarea())
		vv.height = 377
		act(() => listeners.resize?.())

		await waitFor(() => expect(wrapper.style.transform).toBe('translateY(-290px)'))

		Object.defineProperty(window, 'visualViewport', {
			configurable: true,
			value: originalVisualViewport,
		})
	})

	it('clears chipError on successful text-input submit after a prior chip failure', async () => {
		createConversationMock.mockRejectedValueOnce(new Error('sidebar error'))
		createConversationMock.mockResolvedValue({ id: 'conv-1' })
		const user = userEvent.setup()
		render(<SparseComposer itemsCount={0} />)
		// Trigger a chip error.
		await user.click(screen.getByRole('button', { name: 'Help me plan a new bet' }))
		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
		// Successful text-input submit should clear the error.
		await user.type(getTextarea(), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => expect(createConversationMock).toHaveBeenCalledTimes(2))
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})
})
