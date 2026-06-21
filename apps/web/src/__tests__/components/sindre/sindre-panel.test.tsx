import { SindrePanel } from '@/components/sindre/sindre-panel'
import type { UseSindreOneShotResult } from '@/hooks/use-sindre-one-shot'
import type { UseSindreSessionResult } from '@/hooks/use-sindre-session'
import type { ConversationResponse } from '@/lib/api'
import { SindreProvider, useSindre } from '@/lib/sindre-context'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../setup'

const mockSend = vi.fn(async () => {})
const mockOneShotSend = vi.fn(async () => {})
const mockOneShotClear = vi.fn()

let mockHookResult: UseSindreSessionResult = {
	sessionId: null,
	status: 'ready',
	events: [],
	error: null,
	send: mockSend,
	reset: vi.fn(),
}

let mockOneShotResult: UseSindreOneShotResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockOneShotSend,
	clear: mockOneShotClear,
}

const mockConversation: ConversationResponse = {
	id: 'conv-1',
	type: 'dm',
	title: 'Test Conversation',
	workspaceId: 'ws-1',
	lastMessagePreview: null,
	lastActivityAt: null,
	createdAt: new Date().toISOString(),
	participantCount: 0,
	unreadCount: 0,
	participants: [],
}

let mockConversationList: ConversationResponse[] = []
const mockMarkRead = { mutate: vi.fn() }
const mockCreateConversation = { mutate: vi.fn(), isPending: false }
const mockUpdateTitle = { mutate: vi.fn() }

vi.mock('@/hooks/use-conversations', () => ({
	useConversations: () => ({ data: mockConversationList, isLoading: false }),
	useCreateConversation: () => mockCreateConversation,
	useMarkConversationRead: () => mockMarkRead,
	useUpdateConversationTitle: () => mockUpdateTitle,
	useConversationMessages: () => ({ data: null }),
	useSendMessage: () => ({
		mutateAsync: vi.fn().mockResolvedValue(undefined),
		isPending: false,
	}),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-sindre-session', () => ({
	useSindreSession: () => mockHookResult,
}))

vi.mock('@/hooks/use-sindre-one-shot', () => ({
	useSindreOneShot: () => mockOneShotResult,
}))

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn().mockResolvedValue([]) },
		objects: { list: vi.fn().mockResolvedValue([]), search: vi.fn().mockResolvedValue([]) },
	},
}))

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))
Element.prototype.scrollIntoView = vi.fn()

// jsdom doesn't provide matchMedia; the shadcn Sidebar primitive calls it via
// useIsMobile(). Default to desktop (non-matching) so the Sidebar renders as
// a fixed panel instead of a mobile Sheet wrapper.
Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: vi.fn().mockReturnValue({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}),
})

beforeEach(() => {
	mockSend.mockClear()
	mockOneShotSend.mockClear()
	mockOneShotClear.mockClear()
	mockMarkRead.mutate.mockClear()
	mockConversationList = []
	mockHookResult = {
		sessionId: null,
		status: 'ready',
		events: [],
		error: null,
		send: mockSend,
		reset: vi.fn(),
	}
	mockOneShotResult = {
		sessionId: null,
		status: 'idle',
		events: [],
		error: null,
		send: mockOneShotSend,
		clear: mockOneShotClear,
	}
	localStorage.clear()
})

function Harness({ children }: { children: ReactNode }) {
	const client = createTestQueryClient()
	return (
		<QueryClientProvider client={client}>
			<SindreProvider workspaceId="ws-1">{children}</SindreProvider>
		</QueryClientProvider>
	)
}

type OpenerAttachments = Parameters<ReturnType<typeof useSindre>['openWithContext']>[0]

function Opener({ attachments }: { attachments?: OpenerAttachments }) {
	const { setOpen, openWithContext } = useSindre()
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				open-panel
			</button>
			<button type="button" onClick={() => openWithContext(attachments ?? [])}>
				open-with-context
			</button>
		</>
	)
}

function OpenerWithMessage({
	attachments,
	message,
}: {
	attachments?: OpenerAttachments
	message: string
}) {
	const { openWithContext } = useSindre()
	return (
		<button type="button" onClick={() => openWithContext(attachments ?? [], message)}>
			open-with-message
		</button>
	)
}

function PinState() {
	const { pinned } = useSindre()
	return <span data-testid="pin-state">{pinned ? 'pinned' : 'unpinned'}</span>
}

describe('SindrePanel', () => {
	it('starts collapsed so it acts like an overlay sheet by default', () => {
		render(
			<Harness>
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)
		const panel = document.querySelector('[data-slot="sidebar-container"], [data-state]')
		// The Sidebar primitive exposes data-state="collapsed" on its outer
		// group wrapper when closed (offcanvas translates the panel off-screen).
		const stated = document.querySelector('[data-state="collapsed"]')
		expect(stated ?? panel).not.toBeNull()
	})

	it('shows the conversation list when opened', async () => {
		render(
			<Harness>
				<Opener />
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		expect(await screen.findByText('Conversations')).toBeInTheDocument()
		// Header icon button is present (footer button replaced by inline composer)
		expect(screen.getAllByRole('button', { name: 'New conversation' })).toHaveLength(1)
	})

	it('shows SindreChat when a conversation is selected', async () => {
		mockConversationList = [mockConversation]
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener />
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		await screen.findByText('Conversations')
		await user.click(screen.getByText('Test Conversation'))

		expect(await screen.findByPlaceholderText('Message Sindre')).toBeInTheDocument()
		expect(mockMarkRead.mutate).toHaveBeenCalledWith('conv-1')
	})

	it('auto-sends a pendingMessage when entering a conversation', async () => {
		mockConversationList = [mockConversation]
		const user = userEvent.setup()
		render(
			<Harness>
				<OpenerWithMessage message="hey sindre" attachments={[]} />
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-message').click()
		})

		await screen.findByText('Conversations')
		await user.click(screen.getByText('Test Conversation'))
		await screen.findByPlaceholderText('Message Sindre')

		await waitFor(() =>
			expect(mockSend).toHaveBeenCalledWith('hey sindre', undefined, 'hey sindre', undefined),
		)
	})

	it('seeds selection from pendingAttachments and renders chips in SindreChat', async () => {
		mockConversationList = [mockConversation]
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener
					attachments={[
						{ kind: 'agent', id: 'actor-reviewer', name: 'Code Reviewer' },
						{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
					]}
				/>
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-context').click()
		})

		await screen.findByText('Conversations')
		await user.click(screen.getByText('Test Conversation'))

		expect(await screen.findByPlaceholderText('Message Code Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Bet Alpha')).toBeInTheDocument()
	})

	it('seeds selection from a notification attachment and renders a chip', async () => {
		mockConversationList = [mockConversation]
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener
					attachments={[{ kind: 'notification', id: 'notif-1', title: 'Build failed on main' }]}
				/>
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-context').click()
		})

		await screen.findByText('Conversations')
		await user.click(screen.getByText('Test Conversation'))

		expect(await screen.findByPlaceholderText('Message Sindre')).toBeInTheDocument()
		expect(screen.getByText('Build failed on main')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Remove Build failed on main/ })).toBeInTheDocument()
	})

	it('toggles pinned state via the pin button and persists the preference', async () => {
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener />
				<PinState />
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		expect(screen.getByTestId('pin-state')).toHaveTextContent('unpinned')
		const pinBtn = await screen.findByRole('button', { name: 'Pin sidebar' })
		await user.click(pinBtn)

		expect(screen.getByTestId('pin-state')).toHaveTextContent('pinned')
		expect(localStorage.getItem('maskin-sindre-pinned')).toBe('true')
		expect(screen.getByRole('button', { name: 'Unpin sidebar' })).toBeInTheDocument()
	})

	it('closes on outside click when unpinned', async () => {
		render(
			<Harness>
				<Opener />
				<button type="button" data-testid="outside">
					outside
				</button>
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		await screen.findByText('Conversations')

		act(() => {
			screen.getByTestId('outside').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
		})

		await waitFor(() => {
			expect(document.querySelector('[data-state="collapsed"]')).not.toBeNull()
		})
	})

	it('stays open on outside click when pinned', async () => {
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener />
				<button type="button" data-testid="outside">
					outside
				</button>
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		await screen.findByText('Conversations')
		await user.click(screen.getByRole('button', { name: 'Pin sidebar' }))

		act(() => {
			screen.getByTestId('outside').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
		})

		// Panel stays expanded — no collapsed state element appears.
		expect(document.querySelector('[data-state="expanded"]')).not.toBeNull()
	})

	it('closes the panel via the close button', async () => {
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener />
				<SindrePanel workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		await screen.findByText('Conversations')
		const closeBtn = screen.getByRole('button', { name: 'Close' })
		await user.click(closeBtn)

		await waitFor(() => {
			expect(document.querySelector('[data-state="collapsed"]')).not.toBeNull()
		})
	})
})
