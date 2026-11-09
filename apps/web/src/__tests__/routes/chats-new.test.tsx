import { render, screen, waitFor, within } from '@testing-library/react'
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

// The shared composer has its own tests; here it is a box that reports what the route gives it.
vi.mock('@/components/chat/chat', () => ({
	Composer: (props: {
		value?: string
		onValueChange?: (v: string) => void
		onSend: (content: string) => Promise<void>
		placeholder: string
		textareaLabel?: string
		externalError?: string | null
		selection: { objects: { id: string; title: string | null }[] }
		onRemoveObject: (id: string) => void
	}) => (
		<div>
			<textarea
				aria-label={props.textareaLabel}
				placeholder={props.placeholder}
				value={props.value ?? ''}
				onChange={(e) => props.onValueChange?.(e.target.value)}
			/>
			{props.selection.objects.map((o) => (
				<button key={o.id} type="button" onClick={() => props.onRemoveObject(o.id)}>
					{`Remove ${o.title}`}
				</button>
			))}
			{props.externalError ? <p role="alert">{props.externalError}</p> : null}
			<button
				type="button"
				onClick={() => props.onSend((props.value ?? '').trim()).catch(() => {})}
			>
				Send
			</button>
		</div>
	),
}))

import { Route } from '@/routes/_authed/$workspaceId/chats/new'

const NewChatPage = (Route as unknown as { component: React.FC }).component

const CHIEF = { id: 'cos-1', name: 'Chief of Staff', type: 'agent' }
const FORGE = { id: 'forge-1', name: 'Forge', type: 'agent' }
const SENTINEL = { id: 'sentinel-1', name: 'Sentinel', type: 'agent' }

const toField = () => screen.getByRole('combobox', { name: 'Add a person or agent' })

async function waitForDefaultPick() {
	await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Chief of Staff' })))
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

	it('has a back link to Chats, a To field and the composer', () => {
		render(<NewChatPage />)
		expect(screen.getByRole('link', { name: 'Chats' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'New chat' })).toBeInTheDocument()
		expect(toField()).toBeInTheDocument()
		expect(screen.getByLabelText('First message')).toBeInTheDocument()
	})

	it('preselects the workspace default chat agent as a removable chip', async () => {
		render(<NewChatPage />)
		await waitForDefaultPick()
		expect(screen.queryByRole('button', { name: 'Remove Forge' })).not.toBeInTheDocument()
	})

	it('preselects the ?agentId= agent instead of the default', async () => {
		mockSearch.mockReturnValue({ agentId: 'forge-1' })
		render(<NewChatPage />)
		await screen.findByRole('button', { name: 'Remove Forge' })
		expect(screen.queryByRole('button', { name: 'Remove Chief of Staff' })).not.toBeInTheDocument()
	})

	it('shows Suggested only while the To field is focused, A to Z, without the chips already added', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
		await user.click(toField())
		const list = screen.getByRole('listbox')
		const names = within(list)
			.getAllByRole('option')
			.map((o) => o.textContent ?? '')
		expect(names).toHaveLength(2)
		expect(names[0]).toContain('Forge')
		expect(names[1]).toContain('Sentinel')
		await user.tab()
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
	})

	it('filters the list as you type and adds the match on Enter', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.type(toField(), 'sen')
		expect(screen.getAllByRole('option')).toHaveLength(1)
		await user.keyboard('{Enter}')
		expect(screen.getByRole('button', { name: 'Remove Sentinel' })).toBeInTheDocument()
		expect(toField()).toHaveValue('')
	})

	it('removes the last chip on Backspace in an empty field', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.click(toField())
		await user.keyboard('{Backspace}')
		expect(screen.queryByRole('button', { name: 'Remove Chief of Staff' })).not.toBeInTheDocument()
	})

	it('never offers integration system members', async () => {
		const user = userEvent.setup()
		mockMembers.mockReturnValue([
			{ actorId: 'sys-1', name: 'GitHub bot', type: 'system', role: 'member' },
			{ actorId: 'h-1', name: 'Bente', type: 'human', role: 'member' },
		])
		render(<NewChatPage />)
		await user.click(toField())
		expect(screen.queryByRole('option', { name: /GitHub bot/ })).not.toBeInTheDocument()
		expect(screen.getByRole('option', { name: /Bente/ })).toBeInTheDocument()
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
		await user.type(toField(), 'forge{Enter}')
		expect(screen.queryByText(/Pick one agent for a direct chat/)).not.toBeInTheDocument()
		expect(screen.queryByText(/This starts a group chat/)).not.toBeInTheDocument()
	})

	it('asks for at least one recipient and creates nothing when none is left', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.click(screen.getByRole('button', { name: 'Remove Chief of Staff' }))
		await user.click(screen.getByRole('button', { name: 'Send' }))
		expect(screen.getByText(/Pick at least one person or agent/)).toBeInTheDocument()
		expect(mockCreateConversation).not.toHaveBeenCalled()
	})

	it('starts a solo chat with the first message and opens it', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.type(screen.getByLabelText('First message'), 'Plan the launch')
		await user.click(screen.getByRole('button', { name: 'Send' }))
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

	it('starts a group chat with every chip', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await waitForDefaultPick()
		await user.type(toField(), 'forge{Enter}')
		await user.click(screen.getByRole('button', { name: 'Send' }))
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
		it('carries them as removable context and sends the rest with the message', async () => {
			const user = userEvent.setup()
			mockSearch.mockReturnValue({ objectIds: 'o-1,o-2' })
			mockReferencedObjects.mockReturnValue([
				{ id: 'o-1', title: 'Pricing bet', type: 'bet' },
				{ id: 'o-2', title: 'Churn insight', type: 'insight' },
			])
			render(<NewChatPage />)
			await screen.findByRole('button', { name: 'Remove Pricing bet' })
			await user.click(screen.getByRole('button', { name: 'Remove Churn insight' }))
			expect(screen.queryByRole('button', { name: 'Remove Churn insight' })).not.toBeInTheDocument()

			await waitForDefaultPick()
			await user.type(screen.getByLabelText('First message'), 'Look at these')
			await user.click(screen.getByRole('button', { name: 'Send' }))
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
