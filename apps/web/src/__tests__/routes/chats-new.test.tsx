import { render, screen, waitFor } from '@testing-library/react'
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
		useSearch: () => mockSearch(),
		useNavigate: () => mockNavigate,
	}
})

const mockCreateConversation = vi.fn()
const mockConversationsInfinite = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: mockCreateConversation, isPending: false }),
	useConversationsInfinite: () => ({ data: mockConversationsInfinite() }),
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

const toastCapture = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: { warning: toastCapture.warning } }))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me-1', name: 'You', type: 'human' }),
}))

const trackChatSessionStartedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: (name: string | null) =>
		name ? name.toLowerCase().replace(/\s+/g, '-') : null,
	trackChatSessionStarted: trackChatSessionStartedMock,
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
const SENTINEL = {
	id: 'sentinel-1',
	name: 'Sentinel',
	type: 'agent',
	description: 'Watches accounts',
}

function conversationsPage(
	convs: Array<{
		id: string
		lastMessageAt: string | null
		participants: Array<{ actorId: string; actorName: string; actorType: 'human' | 'agent' }>
	}>,
) {
	return {
		pages: [
			{
				conversations: convs.map((c) => ({
					id: c.id,
					workspaceId: 'ws-1',
					title: '',
					createdBy: 'me-1',
					lastMessageAt: c.lastMessageAt,
					createdAt: c.lastMessageAt,
					updatedAt: c.lastMessageAt,
					pinned: false,
					archived: false,
					unread_count: 0,
					snippet: null,
					snippet_actor_id: null,
					snippet_actor_name: null,
					participants: c.participants.map((p) => ({ ...p, joinedAt: null, addedBy: null })),
				})),
				has_more: false,
			},
		],
	}
}

describe('New chat', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSearch.mockReturnValue({})
		mockActors.mockReturnValue([CHIEF, FORGE, SENTINEL])
		mockReferencedObjects.mockReturnValue(undefined)
		mockConversationsInfinite.mockReturnValue(undefined)
		mockCreateConversation.mockResolvedValue({ id: 'conv-1' })
	})

	it('does not render the removed CHAT_SUGGESTIONS list', () => {
		render(<NewChatPage />)
		expect(screen.queryByText('What needs a decision from me today?')).not.toBeInTheDocument()
		expect(screen.queryByText('Summarise what the loops did overnight')).not.toBeInTheDocument()
	})

	it('seeds the workspace default chat agent as an initial chip', async () => {
		render(<NewChatPage />)
		expect(await screen.findByLabelText('Remove Chief of Staff')).toBeInTheDocument()
	})

	it('seeds the ?agentId= URL param as a chip when present', async () => {
		mockSearch.mockReturnValue({ agentId: 'forge-1' })
		render(<NewChatPage />)
		expect(await screen.findByLabelText('Remove Forge')).toBeInTheDocument()
	})

	it('renders a RECENT eyebrow with recently-collaborated actors on empty query', () => {
		mockConversationsInfinite.mockReturnValue(
			conversationsPage([
				{
					id: 'c-1',
					lastMessageAt: '2026-09-01T10:00:00.000Z',
					participants: [
						{ actorId: 'me-1', actorName: 'You', actorType: 'human' },
						{ actorId: 'forge-1', actorName: 'Forge', actorType: 'agent' },
					],
				},
			]),
		)
		render(<NewChatPage />)
		expect(screen.getByText('RECENT')).toBeInTheDocument()
		expect(screen.getByRole('option', { name: /Forge/ })).toBeInTheDocument()
	})

	it('omits the RECENT section entirely when the derivation returns zero candidates', () => {
		mockConversationsInfinite.mockReturnValue({ pages: [] })
		render(<NewChatPage />)
		expect(screen.queryByText('RECENT')).not.toBeInTheDocument()
	})

	it('switches the dropdown label to ADD SOMEONE — PERSON OR AGENT once the input has 1+ chars', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await user.type(screen.getByLabelText('Add recipients'), 'f')
		expect(screen.getByText('ADD SOMEONE \u2014 PERSON OR AGENT')).toBeInTheDocument()
	})

	it('renders the muted empty-match line when the typed query has no matches', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await user.type(screen.getByLabelText('Add recipients'), 'zzz-nothing')
		expect(screen.getByText('No agent by that name')).toBeInTheDocument()
	})

	it('commits the highlighted row when Enter is pressed in the input', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await screen.findByLabelText('Remove Chief of Staff')
		const input = screen.getByLabelText('Add recipients')
		await user.type(input, 'Forge{Enter}')
		expect(screen.getByLabelText('Remove Forge')).toBeInTheDocument()
	})

	it('removes a chip via its × button', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		const removeBtn = await screen.findByLabelText('Remove Chief of Staff')
		await user.click(removeBtn)
		expect(screen.queryByLabelText('Remove Chief of Staff')).not.toBeInTheDocument()
	})

	it('pops the last chip when Backspace is pressed on an empty input', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await screen.findByLabelText('Remove Chief of Staff')
		const input = screen.getByLabelText('Add recipients')
		await user.click(input)
		await user.keyboard('{Backspace}')
		expect(screen.queryByLabelText('Remove Chief of Staff')).not.toBeInTheDocument()
	})

	it('renders the chatGroupNote inline once 2+ recipients are selected', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await screen.findByLabelText('Remove Chief of Staff')
		await user.type(screen.getByLabelText('Add recipients'), 'Forge{Enter}')
		expect(await screen.findByLabelText('Remove Forge')).toBeInTheDocument()
		expect(screen.getByText('Everyone sees everything')).toBeInTheDocument()
	})

	it('fires chat_session_started with participant_count=1 on a solo send', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await screen.findByLabelText('Remove Chief of Staff')
		await user.type(
			screen.getByLabelText('Message this conversation'),
			'What are we working on?{Enter}',
		)
		await waitFor(() => expect(trackChatSessionStartedMock).toHaveBeenCalledTimes(1))
		expect(trackChatSessionStartedMock).toHaveBeenCalledWith(
			expect.objectContaining({ participant_count: 1 }),
		)
	})

	it('fires chat_session_started with participant_count=2 on a group send', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await screen.findByLabelText('Remove Chief of Staff')
		await user.type(screen.getByLabelText('Add recipients'), 'Forge{Enter}')
		await screen.findByLabelText('Remove Forge')
		await user.type(
			screen.getByLabelText('Message this conversation'),
			'What are we working on?{Enter}',
		)
		await waitFor(() => expect(trackChatSessionStartedMock).toHaveBeenCalledTimes(1))
		expect(trackChatSessionStartedMock).toHaveBeenCalledWith(
			expect.objectContaining({ participant_count: 2 }),
		)
	})
})
