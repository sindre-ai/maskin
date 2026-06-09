import { ConversationDrawer } from '@/components/chat/conversation-drawer'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

// Radix Sheet uses CSS transitions that loop in jsdom; render plain divs instead
vi.mock('@/components/ui/sheet', () => ({
	Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
		open ? <div>{children}</div> : null,
	SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			list: vi.fn().mockResolvedValue([]),
			create: vi.fn(),
			messages: vi.fn().mockResolvedValue({ data: [], total: 0 }),
			sendMessage: vi.fn().mockResolvedValue({
				id: 'm1',
				conversationId: 'c1',
				actorId: 'a1',
				content: 'hi',
				createdAt: new Date().toISOString(),
			}),
			markRead: vi.fn().mockResolvedValue({ ok: true }),
		},
	},
}))

const dmConversation = {
	id: 'c1',
	workspaceId: 'ws-test',
	title: 'Q3 planning',
	type: 'dm' as const,
	lastMessagePreview: null,
	lastActivityAt: new Date().toISOString(),
	createdAt: new Date().toISOString(),
	participantCount: 1,
	unreadCount: 0,
	participants: [],
}

function Harness({
	open = true,
	onOpenChange = vi.fn(),
}: {
	open?: boolean
	onOpenChange?: (v: boolean) => void
}) {
	const Wrapper = createWorkspaceWrapper()
	return (
		<Wrapper>
			<ConversationDrawer open={open} onOpenChange={onOpenChange} />
		</Wrapper>
	)
}

describe('ConversationDrawer', () => {
	it('renders the header with Conversations title when open', async () => {
		render(<Harness />)
		expect(await screen.findByText('Conversations')).toBeInTheDocument()
	})

	it('shows empty state when there are no conversations', async () => {
		render(<Harness />)
		expect(await screen.findByText('No conversations yet')).toBeInTheDocument()
	})

	it('renders the New conversation footer button', async () => {
		render(<Harness />)
		expect(await screen.findByText('New conversation')).toBeInTheDocument()
	})

	it('renders a Recent section with dm conversations', async () => {
		const { api } = await import('@/lib/api')
		vi.mocked(api.conversations.list).mockResolvedValueOnce([dmConversation])

		render(<Harness />)

		expect(await screen.findByText('Recent')).toBeInTheDocument()
		expect(screen.getByText('Q3 planning')).toBeInTheDocument()
	})

	it('navigates to the active conversation on row click', async () => {
		const { api } = await import('@/lib/api')
		vi.mocked(api.conversations.list).mockResolvedValueOnce([dmConversation])
		vi.mocked(api.conversations.messages).mockResolvedValueOnce({ data: [], total: 0 })

		const user = userEvent.setup()
		render(<Harness />)

		const row = await screen.findByText('Q3 planning')
		await user.click(row)

		expect(await screen.findByPlaceholderText('Continue conversation…')).toBeInTheDocument()
	})

	it('back button returns to list from active conversation', async () => {
		const { api } = await import('@/lib/api')
		vi.mocked(api.conversations.list).mockResolvedValueOnce([dmConversation])
		vi.mocked(api.conversations.messages).mockResolvedValueOnce({ data: [], total: 0 })

		const user = userEvent.setup()
		render(<Harness />)

		await user.click(await screen.findByText('Q3 planning'))
		await user.click(await screen.findByRole('button', { name: 'Back to conversations' }))

		await waitFor(() => expect(screen.getByText('Conversations')).toBeInTheDocument())
	})

	it('close button calls onOpenChange(false)', async () => {
		const onOpenChange = vi.fn()
		const user = userEvent.setup()
		render(<Harness onOpenChange={onOpenChange} />)

		await screen.findByText('Conversations')
		// Radix SheetContent also renders an aria-label="Close" button; take the last one (our custom header button)
		const closeButtons = screen.getAllByRole('button', { name: 'Close' })
		await user.click(closeButtons[closeButtons.length - 1])

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
	})

	it('does not render the panel when closed', () => {
		render(<Harness open={false} />)
		expect(screen.queryByText('Conversations')).not.toBeInTheDocument()
	})
})
