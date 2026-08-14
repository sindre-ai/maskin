import { ChatPanel } from '@/components/chat/chat-panel'
import type { UseChatOneShotResult } from '@/hooks/use-chat-one-shot'
import type { UseChatSessionResult } from '@/hooks/use-chat-session'
import { ChatProvider, useChat } from '@/lib/chat-context'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../setup'

const mockSend = vi.fn(async () => {})
const mockOneShotSend = vi.fn(async () => {})
const mockOneShotClear = vi.fn()

let mockHookResult: UseChatSessionResult = {
	sessionId: null,
	status: 'ready',
	events: [],
	error: null,
	send: mockSend,
	reset: vi.fn(),
}

let mockOneShotResult: UseChatOneShotResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockOneShotSend,
	clear: mockOneShotClear,
}

vi.mock('@/hooks/use-chat-session', () => ({
	useChatSession: () => mockHookResult,
}))

vi.mock('@/hooks/use-chat-one-shot', () => ({
	useChatOneShot: () => mockOneShotResult,
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
			<ChatProvider workspaceId="ws-1">{children}</ChatProvider>
		</QueryClientProvider>
	)
}

type OpenerAttachments = Parameters<ReturnType<typeof useChat>['openWithContext']>[0]

function Opener({ attachments }: { attachments?: OpenerAttachments }) {
	const { setOpen, openWithContext } = useChat()
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
	const { openWithContext } = useChat()
	return (
		<button type="button" onClick={() => openWithContext(attachments ?? [], message)}>
			open-with-message
		</button>
	)
}

function PinState() {
	const { pinned } = useChat()
	return <span data-testid="pin-state">{pinned ? 'pinned' : 'unpinned'}</span>
}

describe('ChatPanel', () => {
	it('starts collapsed so it acts like an overlay sheet by default', () => {
		render(
			<Harness>
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)
		const panel = document.querySelector('[data-slot="sidebar-container"], [data-state]')
		// The Sidebar primitive exposes data-state="collapsed" on its outer
		// group wrapper when closed (offcanvas translates the panel off-screen).
		const stated = document.querySelector('[data-state="collapsed"]')
		expect(stated ?? panel).not.toBeNull()
	})

	it('mounts Chat inside the panel when opened', async () => {
		render(
			<Harness>
				<Opener />
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		expect(await screen.findByPlaceholderText('Message agents')).toBeInTheDocument()
	})

	it('auto-sends a pendingMessage forwarded via openWithContext and clears it', async () => {
		render(
			<Harness>
				<Opener attachments={[]} />
				<OpenerWithMessage message="hey sindre" attachments={[]} />
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-message').click()
		})

		await screen.findByPlaceholderText('Message agents')
		await waitFor(() =>
			expect(mockSend).toHaveBeenCalledWith('hey sindre', undefined, 'hey sindre', undefined),
		)
	})

	it('seeds selection from pendingAttachments and clears them on open', async () => {
		render(
			<Harness>
				<Opener
					attachments={[
						{ kind: 'agent', id: 'actor-reviewer', name: 'Code Reviewer' },
						{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
					]}
				/>
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-context').click()
		})

		expect(await screen.findByPlaceholderText('Message Code Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Bet Alpha')).toBeInTheDocument()
	})

	it('seeds selection from a file attachment forwarded via openWithContext', async () => {
		render(
			<Harness>
				<Opener
					attachments={[
						{
							kind: 'file',
							fileId: 'file-42',
							name: 'sunset.png',
							sizeBytes: 4096,
							mimeType: 'image/png',
						},
					]}
				/>
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-context').click()
		})

		expect(await screen.findByPlaceholderText('Message agents')).toBeInTheDocument()
		expect(screen.getByText('sunset.png')).toBeInTheDocument()
	})

	it('seeds selection from a notification attachment and renders a chip (verification #9)', async () => {
		render(
			<Harness>
				<Opener
					attachments={[{ kind: 'notification', id: 'notif-1', title: 'Build failed on main' }]}
				/>
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-context').click()
		})

		expect(await screen.findByPlaceholderText('Message agents')).toBeInTheDocument()
		expect(screen.getByText('Build failed on main')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Remove Build failed on main/ })).toBeInTheDocument()
	})

	it('toggles pinned state via the pin button and persists the preference', async () => {
		const user = userEvent.setup()
		render(
			<Harness>
				<Opener />
				<PinState />
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		expect(screen.getByTestId('pin-state')).toHaveTextContent('unpinned')
		const pinBtn = await screen.findByRole('button', { name: 'Pin sidebar' })
		await user.click(pinBtn)

		expect(screen.getByTestId('pin-state')).toHaveTextContent('pinned')
		expect(localStorage.getItem('maskin-chat-pinned')).toBe('true')
		// After toggling, the button's label flips to the unpin affordance.
		expect(screen.getByRole('button', { name: 'Unpin sidebar' })).toBeInTheDocument()
	})

	it('closes on outside click when unpinned', async () => {
		render(
			<Harness>
				<Opener />
				<button type="button" data-testid="outside">
					outside
				</button>
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		// Panel is open (open state flipped) and unpinned by default.
		await screen.findByPlaceholderText('Message agents')

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
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		await screen.findByPlaceholderText('Message agents')
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
				<ChatPanel workspaceId="ws-1" agentActorId="actor-agent" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-panel').click()
		})

		const closeBtn = await screen.findByRole('button', { name: 'Close chat' })
		await user.click(closeBtn)

		await waitFor(() => {
			expect(document.querySelector('[data-state="collapsed"]')).not.toBeNull()
		})
	})
})
