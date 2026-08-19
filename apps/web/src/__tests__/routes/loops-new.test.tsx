import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useNavigate: () => mockNavigate,
	}
})

const mockCreateConversation = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({
		mutateAsync: mockCreateConversation,
		isPending: false,
	}),
}))

const mockDefaultAgent = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => mockDefaultAgent(),
	useActors: () => ({ data: [] }),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: () => null,
}))

// The real composer pulls the whole chat surface in; this route only needs the
// one thing it does — hand a sentence to `onSend`.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		onSend,
		textareaLabel,
		placeholder,
	}: {
		onSend: (value: string) => Promise<void>
		textareaLabel: string
		placeholder: string
	}) => (
		<textarea
			aria-label={textareaLabel}
			placeholder={placeholder}
			onKeyDown={(e) => {
				if (e.key === 'Enter') void onSend((e.target as HTMLTextAreaElement).value)
			}}
		/>
	),
}))

import { Route } from '@/routes/_authed/$workspaceId/loops/new'

const NewLoopPage = (Route as unknown as { component: React.FC }).component

describe('New loop', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockDefaultAgent.mockReturnValue({ id: 'cos-1', name: 'Chief of Staff' })
		mockCreateConversation.mockResolvedValue({ id: 'conv-1' })
	})

	it('names the three primitives a loop is made of', () => {
		render(<NewLoopPage />)

		expect(screen.getByRole('heading', { name: 'What should the loop do?' })).toBeInTheDocument()
		expect(screen.getByText('OBJECT TYPE')).toBeInTheDocument()
		expect(screen.getByText('TRIGGER')).toBeInTheDocument()
		expect(screen.getByText('AGENT')).toBeInTheDocument()
	})

	it('hands a described loop to the Chief of Staff and opens that conversation', async () => {
		const user = userEvent.setup()
		render(<NewLoopPage />)

		const composer = screen.getByRole('textbox', { name: /describe your loop/i })
		await user.type(composer, 'Chase every unpaid invoice for me{Enter}')

		expect(mockCreateConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				participant_actor_ids: ['cos-1'],
				initial_message: 'Chase every unpaid invoice for me',
			}),
		)
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: 'conv-1' },
		})
	})

	it('starts the same conversation from an example sentence', async () => {
		const user = userEvent.setup()
		render(<NewLoopPage />)

		await user.click(
			screen.getByRole('button', { name: /When a customer reports a bug in Slack/i }),
		)

		expect(mockCreateConversation).toHaveBeenCalledWith(
			expect.objectContaining({ participant_actor_ids: ['cos-1'] }),
		)
	})

	it('says so rather than silently doing nothing when no agent can take it', async () => {
		mockDefaultAgent.mockReturnValue(null)
		const user = userEvent.setup()
		render(<NewLoopPage />)

		await user.click(
			screen.getByRole('button', { name: /When a customer reports a bug in Slack/i }),
		)

		expect(mockCreateConversation).not.toHaveBeenCalled()
		expect(await screen.findByRole('alert')).toHaveTextContent(/No agent is available/i)
	})
})
