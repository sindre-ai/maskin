import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
const mockSearch = vi.fn(() => ({}) as Record<string, string | undefined>)
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => mockSearch(),
		}),
		useNavigate: () => mockNavigate,
	}
})

const mockCreateConversation = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: mockCreateConversation, isPending: false }),
}))

const mockActors = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: mockActors() }),
	useDefaultChatAgent: () => ({ id: 'cos-1', name: 'Chief of Staff' }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [] }),
}))

const mockReferencedObjects = vi.fn()
vi.mock('@/hooks/use-objects', () => ({
	useObjects: () => ({ data: mockReferencedObjects() }),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me-1', name: 'You', type: 'human' }),
}))

// The real composer pulls the whole chat surface in; this route needs only the
// two things it does — carry a controlled draft, and hand a message to onSend.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		onSend,
		textareaLabel,
		placeholder,
		value,
		onValueChange,
	}: {
		onSend: (value: string) => Promise<void>
		textareaLabel: string
		placeholder: string
		value?: string
		onValueChange?: (next: string) => void
	}) => (
		<textarea
			aria-label={textareaLabel}
			placeholder={placeholder}
			value={value ?? ''}
			onChange={(e) => onValueChange?.(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') void onSend((e.target as HTMLTextAreaElement).value)
			}}
		/>
	),
}))

import { Route } from '@/routes/_authed/$workspaceId/chats/new'

const NewChatPage = (Route as unknown as { component: React.FC }).component

const CHIEF = {
	id: 'cos-1',
	name: 'Chief of Staff',
	type: 'agent',
	description: 'Starts anywhere and hands it to the agent that owns it',
}
const FORGE = { id: 'forge-1', name: 'Forge', type: 'agent', description: 'Ships billing fixes' }

describe('New chat', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSearch.mockReturnValue({})
		mockActors.mockReturnValue([CHIEF, FORGE])
		mockReferencedObjects.mockReturnValue(undefined)
		mockCreateConversation.mockResolvedValue({ id: 'conv-1' })
	})

	it('addresses the draft to the workspace default agent and says what it does', () => {
		render(<NewChatPage />)

		expect(screen.getByRole('heading', { name: 'What are we working on?' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Talking to Chief of Staff/ })).toBeInTheDocument()
		expect(
			screen.getByText('answers first, hands it on if someone else owns it'),
		).toBeInTheDocument()
		expect(screen.getByLabelText('Message this conversation')).toHaveAttribute(
			'placeholder',
			'Message Chief of Staff…',
		)
	})

	it('attributes a suggestion to the real agent that answers it, not the prototype cast', () => {
		render(<NewChatPage />)

		// "Forge" is seeded here, so its row keeps the mockup's attribution.
		expect(
			screen.getByRole('button', { name: /Why is the retry window still open\?\s*Forge/ }),
		).toBeInTheDocument()
		// "Sentinel" is not in this workspace — the row names whoever would
		// actually answer instead of a name that doesn't exist here.
		expect(
			screen.getByRole('button', {
				name: /Which accounts went quiet this week\?\s*Chief of Staff/,
			}),
		).toBeInTheDocument()
	})

	it('prefills the composer from a suggestion without sending it', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)

		await user.click(screen.getByRole('button', { name: /What needs a decision from me today/ }))

		expect(screen.getByLabelText('Message this conversation')).toHaveValue(
			'What needs a decision from me today?',
		)
		expect(mockCreateConversation).not.toHaveBeenCalled()
	})

	it('retargets the draft when another agent is picked', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)

		await user.click(screen.getByRole('button', { name: /Talking to Chief of Staff/ }))
		// Scoped by the picker row's sub-line — "Forge" alone also matches the
		// suggestion row it is attributed to.
		await user.click(screen.getByRole('button', { name: /Forge\s*Ships billing fixes/ }))

		expect(screen.getByRole('button', { name: /Talking to Forge/ })).toBeInTheDocument()
	})

	it('carries objects handed over by "Ask an agent" into the first message', async () => {
		mockSearch.mockReturnValue({ objectIds: 'obj-1,obj-2' })
		mockReferencedObjects.mockReturnValue([
			{ id: 'obj-1', title: 'Retry window', type: 'bet' },
			{ id: 'obj-2', title: 'Churned accounts', type: 'insight' },
		])
		const user = userEvent.setup()
		render(<NewChatPage />)

		await user.type(screen.getByLabelText('Message this conversation'), 'What links these?{Enter}')

		expect(mockCreateConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				initial_message_metadata: {
					context_objects: [
						{ id: 'obj-1', title: 'Retry window', type: 'bet' },
						{ id: 'obj-2', title: 'Churned accounts', type: 'insight' },
					],
				},
			}),
		)
	})

	it('titles the conversation from the first message, not the agent', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)

		const composer = screen.getByLabelText('Message this conversation')
		await user.type(composer, 'Which accounts went quiet this week?{Enter}')

		expect(mockCreateConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Which accounts went quiet this week?',
				participant_actor_ids: ['cos-1'],
				initial_message: 'Which accounts went quiet this week?',
			}),
		)
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: 'conv-1' },
		})
	})
})
