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
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: mockCreateConversation, isPending: false }),
}))

const mockActors = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: mockActors() }),
	useDefaultChatAgent: () => ({ id: 'cos-1', name: 'Chief of Staff' }),
}))

const mockMembers = vi.fn()
vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: mockMembers() }),
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

import { Route } from '@/routes/_authed/$workspaceId/chats/new'

const NewChatPage = (Route as unknown as { component: React.FC }).component

const CHIEF = { id: 'cos-1', name: 'Chief of Staff', type: 'agent' }
const FORGE = { id: 'forge-1', name: 'Forge', type: 'agent' }
const SENTINEL = { id: 'sentinel-1', name: 'Sentinel', type: 'agent' }

async function waitForDefaultPick() {
	await waitFor(() =>
		expect(screen.getByRole('switch', { name: 'Add Chief of Staff' })).toBeChecked(),
	)
}

describe('New chat', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSearch.mockReturnValue({})
		mockActors.mockReturnValue([SENTINEL, CHIEF, FORGE])
		mockMembers.mockReturnValue([])
		mockReferencedObjects.mockReturnValue(undefined)
		mockCreateConversation.mockResolvedValue({ id: 'conv-1' })
	})

	it('lists every agent A to Z with a toggle each, under a back link to Chats', () => {
		render(<NewChatPage />)
		expect(screen.getByRole('link', { name: 'Chats' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'New chat' })).toBeInTheDocument()
		const names = screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))
		expect(names).toEqual(['Add Chief of Staff', 'Add Forge', 'Add Sentinel'])
	})

	it('turns the workspace default chat agent on to start with', async () => {
		render(<NewChatPage />)
		await waitForDefaultPick()
		expect(screen.getByRole('switch', { name: 'Add Forge' })).not.toBeChecked()
	})

	it('turns the ?agentId= agent on instead of the default', async () => {
		mockSearch.mockReturnValue({ agentId: 'forge-1' })
		render(<NewChatPage />)
		await waitFor(() => expect(screen.getByRole('switch', { name: 'Add Forge' })).toBeChecked())
		expect(screen.getByRole('switch', { name: 'Add Chief of Staff' })).not.toBeChecked()
	})

	it('never offers integration system members', () => {
		mockMembers.mockReturnValue([
			{ actorId: 'sys-1', name: 'GitHub bot', type: 'system', role: 'member' },
			{ actorId: 'h-1', name: 'Bente', type: 'human', role: 'member' },
		])
		render(<NewChatPage />)
		expect(screen.queryByRole('switch', { name: 'Add GitHub bot' })).not.toBeInTheDocument()
		expect(screen.getByRole('switch', { name: 'Add Bente' })).toBeInTheDocument()
	})

	it('puts the ?text= param in the message box and sends nothing', () => {
		mockSearch.mockReturnValue({ text: 'Draft this for me' })
		render(<NewChatPage />)
		expect(screen.getByLabelText('First message')).toHaveValue('Draft this for me')
		expect(mockCreateConversation).not.toHaveBeenCalled()
	})

	it('shows no note about direct versus group chats', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		expect(screen.queryByText(/Pick one agent for a direct chat/)).not.toBeInTheDocument()
		await user.click(screen.getByRole('switch', { name: 'Add Forge' }))
		expect(screen.queryByText(/This starts a group chat/)).not.toBeInTheDocument()
	})

	it('asks for at least one pick and creates nothing when none is on', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.click(screen.getByRole('switch', { name: 'Add Chief of Staff' }))
		await user.click(screen.getByRole('button', { name: 'Start chat' }))
		expect(screen.getByText(/Pick at least one person or agent/)).toBeInTheDocument()
		expect(mockCreateConversation).not.toHaveBeenCalled()
	})

	it('starts a solo chat with the first message and opens it', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.type(screen.getByLabelText('First message'), 'Plan the launch')
		await user.click(screen.getByRole('button', { name: 'Start chat' }))
		await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledTimes(1))
		expect(mockCreateConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				participant_actor_ids: ['cos-1'],
				initial_message: 'Plan the launch',
			}),
		)
		expect(trackChatSessionStartedMock).toHaveBeenCalledWith(
			expect.objectContaining({ participant_count: 1, entry_agent_role: 'chief-of-staff' }),
		)
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: 'conv-1' },
		})
	})

	it('starts a chat without a first message and sends no initial message', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.click(screen.getByRole('button', { name: 'Start chat' }))
		await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledTimes(1))
		expect(mockCreateConversation.mock.calls[0]?.[0]).not.toHaveProperty('initial_message')
	})

	it('starts a group chat with every pick', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.click(screen.getByRole('switch', { name: 'Add Forge' }))
		await user.click(screen.getByRole('button', { name: 'Start chat' }))
		await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledTimes(1))
		expect(mockCreateConversation.mock.calls[0]?.[0].participant_actor_ids).toEqual([
			'cos-1',
			'forge-1',
		])
		expect(trackChatSessionStartedMock).toHaveBeenCalledWith(
			expect.objectContaining({ participant_count: 2 }),
		)
	})

	describe('objects handed over from "Ask an agent"', () => {
		it('lists them as removable context rows and sends the rest with the message', async () => {
			const user = userEvent.setup()
			mockSearch.mockReturnValue({ objectIds: 'o-1,o-2' })
			mockReferencedObjects.mockReturnValue([
				{ id: 'o-1', title: 'Pricing bet', type: 'bet' },
				{ id: 'o-2', title: 'Churn insight', type: 'insight' },
			])
			render(<NewChatPage />)
			expect(await screen.findByText('Pricing bet')).toBeInTheDocument()
			expect(screen.getByText('Churn insight')).toBeInTheDocument()

			await user.click(screen.getAllByRole('button', { name: 'Remove' })[1] as HTMLElement)
			expect(screen.queryByText('Churn insight')).not.toBeInTheDocument()

			await user.type(screen.getByLabelText('First message'), 'Look at these')
			await user.click(screen.getByRole('button', { name: 'Start chat' }))
			await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledTimes(1))
			expect(
				mockCreateConversation.mock.calls[0]?.[0].initial_message_metadata.context_objects,
			).toEqual([{ id: 'o-1', title: 'Pricing bet', type: 'bet' }])
		})

		it('warns when some ids no longer resolve', async () => {
			mockSearch.mockReturnValue({ objectIds: 'o-1,o-2,o-3' })
			mockReferencedObjects.mockReturnValue([{ id: 'o-1', title: 'Pricing bet', type: 'bet' }])
			render(<NewChatPage />)
			await waitFor(() =>
				expect(toastCapture.warning).toHaveBeenCalledWith(
					"2 of 3 items couldn't be attached — they may have been deleted.",
				),
			)
		})
	})
})
