import { AgentComposer } from '@/components/agents/agent-composer'
import type { ComposerProps } from '@/components/chat/chat'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'

const createConversationMock = vi.fn()
const navigateMock = vi.fn()
const toastSuccess = vi.fn()

vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: createConversationMock }),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-test', workspace: { id: 'ws-test', settings: {} } }),
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
}))

vi.mock('sonner', () => ({
	toast: { success: (m: string) => toastSuccess(m), error: vi.fn() },
}))

// Minimal stub — the chat Composer's own tests cover its internals. The extra
// button dispatches an object into the selection so the metadata path is
// exercised the way it is on the For You composer.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({ onSend, onDispatchSelection, placeholder, textareaLabel }: ComposerProps) => {
		const [value, setValue] = useState('')
		const [error, setError] = useState<string | null>(null)
		return (
			<form
				onSubmit={(e) => {
					e.preventDefault()
					if (!value.trim()) return
					setError(null)
					void onSend(value).then(
						() => setValue(''),
						(err: Error) => setError(err.message),
					)
				}}
			>
				<textarea
					placeholder={placeholder}
					aria-label={textareaLabel}
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
				<button type="submit" aria-label="Send message" />
				{error ? <p role="alert">{error}</p> : null}
				<button
					type="button"
					aria-label="Seed object"
					onClick={() =>
						onDispatchSelection?.({
							type: 'add_object',
							object: { id: 'obj-1', title: 'Pricing bet', type: 'bet' },
						})
					}
				/>
			</form>
		)
	},
}))

const agent = buildActorResponse({ id: 'agent-1', type: 'agent', name: 'Cass' })

describe('AgentComposer', () => {
	beforeEach(() => {
		createConversationMock.mockReset()
		createConversationMock.mockResolvedValue({ id: 'conv-1' })
		navigateMock.mockReset()
		toastSuccess.mockReset()
	})

	it('addresses the agent by name and says what sending does (mockup 2506)', () => {
		render(<AgentComposer agent={agent} />)
		expect(screen.getByPlaceholderText('Message Cass…')).toBeInTheDocument()
		expect(screen.getByText('Starts a new chat')).toBeInTheDocument()
	})

	// The defect that promoted this task to P1: the send used to create a
	// session directly, which left the agent's reply orphaned — no row in the
	// Chats list, nothing for the user to open. The fix routes through
	// createConversation so the exchange lands on the conversation surface.
	it('starts a chat conversation with the agent as the sole participant', async () => {
		render(<AgentComposer agent={agent} />)
		await userEvent.type(screen.getByLabelText('Message Cass'), 'Sweep the backlog')
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() =>
			expect(createConversationMock).toHaveBeenCalledWith(
				expect.objectContaining({
					participant_actor_ids: ['agent-1'],
					initial_message: 'Sweep the backlog',
					title: expect.stringContaining('Sweep the backlog'),
				}),
			),
		)
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId: 'ws-test', conversationId: 'conv-1' },
			}),
		)
	})

	// Attached objects flow as first-class conversation metadata (matching the
	// /chats/new entry point), not folded into the message body — the backend
	// conversation-responder reads context_objects off the initial message.
	it('attaches selection objects as initial-message metadata', async () => {
		render(<AgentComposer agent={agent} />)
		await userEvent.click(screen.getByRole('button', { name: 'Seed object' }))
		await userEvent.type(screen.getByLabelText('Message Cass'), 'Look at this')
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(createConversationMock).toHaveBeenCalled())
		const payload = createConversationMock.mock.calls[0][0]
		expect(payload.initial_message).toBe('Look at this')
		expect(payload.initial_message_metadata?.context_objects).toEqual([
			{ id: 'obj-1', title: 'Pricing bet', type: 'bet' },
		])
	})

	it('surfaces a failure inline instead of reporting a chat that never started', async () => {
		createConversationMock.mockRejectedValue(new Error('boom'))
		render(<AgentComposer agent={agent} />)
		await userEvent.type(screen.getByLabelText('Message Cass'), 'Try it')
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start a chat with Cass")
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(navigateMock).not.toHaveBeenCalled()
	})
})
