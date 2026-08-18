import { AgentComposer } from '@/components/agents/agent-composer'
import type { ComposerProps } from '@/components/chat/chat'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'

const createSessionMock = vi.fn()
const toastSuccess = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useCreateSession: () => ({ mutateAsync: createSessionMock }),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-test', workspace: { id: 'ws-test', settings: {} } }),
}))

vi.mock('sonner', () => ({
	toast: { success: (m: string) => toastSuccess(m), error: vi.fn() },
}))

// Minimal stub — the chat Composer's own tests cover its internals. The extra
// button dispatches an object into the selection so the one-shot prompt path is
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
		createSessionMock.mockReset()
		createSessionMock.mockResolvedValue({ id: 'sess-1' })
		toastSuccess.mockReset()
	})

	it('addresses the agent by name and says what sending does (mockup 2506)', () => {
		render(<AgentComposer agent={agent} />)
		expect(screen.getByPlaceholderText('Message Cass…')).toBeInTheDocument()
		expect(screen.getByText('Starts a new session')).toBeInTheDocument()
	})

	it('starts a new session with the typed prompt', async () => {
		render(<AgentComposer agent={agent} />)
		await userEvent.type(screen.getByLabelText('Message Cass'), 'Sweep the backlog')
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() =>
			expect(createSessionMock).toHaveBeenCalledWith({
				actor_id: 'agent-1',
				action_prompt: 'Sweep the backlog',
			}),
		)
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
	})

	it('folds attached context into the action prompt', async () => {
		render(<AgentComposer agent={agent} />)
		await userEvent.click(screen.getByRole('button', { name: 'Seed object' }))
		await userEvent.type(screen.getByLabelText('Message Cass'), 'Look at this')
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(createSessionMock).toHaveBeenCalled())
		const prompt = createSessionMock.mock.calls[0][0].action_prompt as string
		expect(prompt).toContain('Look at this')
		expect(prompt).toContain('Pricing bet')
	})

	it('surfaces a failure inline instead of reporting a session that never started', async () => {
		createSessionMock.mockRejectedValue(new Error('boom'))
		render(<AgentComposer agent={agent} />)
		await userEvent.type(screen.getByLabelText('Message Cass'), 'Try it')
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start a session for Cass")
		expect(toastSuccess).not.toHaveBeenCalled()
	})
})
