import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useLinkedChat = vi.fn()

vi.mock('@/hooks/use-linked-chat', () => ({
	useLinkedChat: (ws: string, id: string) => useLinkedChat(ws, id),
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		...rest
	}: { children: React.ReactNode; className?: string } & Record<string, unknown>) => (
		<a
			href="/x"
			className={className}
			aria-label={rest['aria-label'] as string | undefined}
			data-linked-card={rest['data-linked-card'] as string | undefined}
		>
			{children}
		</a>
	),
}))

import { ChatReferenceCard, ChatReferenceChip } from '@/components/chat/linked-object-reference'

const WS = 'ws-1'
const CHAT = 'c1'
const fallback = <a href="/original">the original link</a>

const person = (id: string, name: string, type = 'human') => ({
	actorId: id,
	actorName: name,
	actorType: type,
	joinedAt: null,
	addedBy: null,
})

function chat(overrides: Record<string, unknown> = {}) {
	return {
		id: CHAT,
		title: 'Launch plan',
		pinned: false,
		archived: false,
		updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
		participants: [person('me', 'Me'), person('a', 'Ada'), person('f', 'Forge', 'agent')],
		lastMessage: { text: 'Shipped the **fix**', authorId: 'f', authorName: 'Forge' },
		...overrides,
	}
}

beforeEach(() => {
	useLinkedChat.mockReset()
})

describe('ChatReferenceCard', () => {
	const renderCard = (preview = false) =>
		render(<ChatReferenceCard workspaceId={WS} chatId={CHAT} preview={preview} />)

	it('shows tile in the conversation colours, eyebrow, title, last message, people and footer', () => {
		useLinkedChat.mockReturnValue(chat())
		renderCard()
		const eyebrow = screen.getByText('Chat', { selector: '.eyebrow' })
		expect(eyebrow.previousElementSibling?.className).toContain('bg-type-conversation-bg')
		expect(screen.getByText('Launch plan')).toBeInTheDocument()
		expect(screen.getByText('Forge: Shipped the fix')).toBeInTheDocument()
		expect(screen.getByText('People')).toBeInTheDocument()
		// The other people first, you last.
		expect(screen.getByText('Ada, Forge, Me')).toBeInTheDocument()
		// The last author is in the footer, with the time.
		expect(screen.getAllByText('Forge').length).toBeGreaterThan(0)
		expect(screen.getByText(/Updated/)).toBeInTheDocument()
		expect(document.querySelector('[data-linked-card]')).not.toBeNull()
	})

	it('has no badge for a chat that is neither pinned nor archived', () => {
		useLinkedChat.mockReturnValue(chat())
		renderCard()
		expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
		expect(screen.queryByText('Archived')).not.toBeInTheDocument()
	})

	it('shows Pinned', () => {
		useLinkedChat.mockReturnValue(chat({ pinned: true }))
		renderCard()
		expect(screen.getByText('Pinned')).toBeInTheDocument()
	})

	it('shows Archived, also for a chat that is pinned as well', () => {
		useLinkedChat.mockReturnValue(chat({ archived: true, pinned: true }))
		renderCard()
		expect(screen.getByText('Archived')).toBeInTheDocument()
		expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
	})

	it('names you "You" in the last message', () => {
		useLinkedChat.mockReturnValue(
			chat({ lastMessage: { text: 'On it', authorId: 'me', authorName: 'Me' } }),
		)
		renderCard()
		expect(screen.getByText('You: On it')).toBeInTheDocument()
	})

	it('lists two people by name', () => {
		useLinkedChat.mockReturnValue(
			chat({ participants: [person('a', 'Ada'), person('f', 'Forge')] }),
		)
		renderCard()
		expect(screen.getByText('Ada, Forge')).toBeInTheDocument()
	})

	it('counts the rest after three of five people', () => {
		useLinkedChat.mockReturnValue(
			chat({
				participants: ['Ada', 'Bo', 'Cy', 'Di', 'Ed'].map((name) => person(name, name)),
			}),
		)
		renderCard()
		expect(screen.getByText('Ada, Bo, Cy +2')).toBeInTheDocument()
	})

	it('leaves the last message and the author out for an empty chat', () => {
		useLinkedChat.mockReturnValue(chat({ lastMessage: null }))
		renderCard()
		expect(screen.getByText('Launch plan')).toBeInTheDocument()
		expect(screen.queryByText(/Shipped/)).not.toBeInTheDocument()
		expect(screen.queryByText('Forge')).not.toBeInTheDocument()
		expect(screen.getByText(/Updated/)).toBeInTheDocument()
	})

	it('never shows an unread count', () => {
		useLinkedChat.mockReturnValue({ ...chat(), unread_count: 7 })
		const { container } = renderCard()
		expect(container.textContent).not.toMatch(/unread|\b7\b/i)
	})

	it('shows the skeleton while the chat loads', () => {
		useLinkedChat.mockReturnValue(undefined)
		renderCard()
		expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
	})

	it('says Chat not available, in the dashed look, when the chat cannot be shown', () => {
		useLinkedChat.mockReturnValue(null)
		const { container } = renderCard()
		const card = screen.getByText('Chat not available')
		expect(card).toHaveClass('italic', 'border-dashed')
		expect(container.textContent).not.toMatch(/deleted|member|private/i)
	})

	it('is a preview that is a plain box and not counted as a card', () => {
		useLinkedChat.mockReturnValue(chat())
		renderCard(true)
		expect(document.querySelector('[data-linked-card]')).toBeNull()
		expect(screen.queryByRole('link')).toBeNull()
	})
})

describe('ChatReferenceChip', () => {
	const renderChip = () =>
		render(<ChatReferenceChip workspaceId={WS} chatId={CHAT} fallback={fallback} />)

	it('keeps the original link while the chat loads', () => {
		useLinkedChat.mockReturnValue(undefined)
		renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
	})

	it('reads "Chat: title" as one link, with only the icon and the title on the plate', () => {
		useLinkedChat.mockReturnValue(chat({ pinned: true }))
		renderChip()
		const link = screen.getByRole('link', { name: 'Chat: Launch plan' })
		expect(link).toHaveTextContent(/^⁠?Launch plan$/)
		expect(link.className).toContain('bg-muted')
		expect(link.querySelector('svg')?.getAttribute('class')).toContain('lucide-message-circle')
		expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
	})

	it('says Chat not available when the chat cannot be shown', () => {
		useLinkedChat.mockReturnValue(null)
		renderChip()
		expect(screen.getByText('Chat not available')).toBeInTheDocument()
		expect(screen.queryByRole('link')).toBeNull()
	})
})

describe('chat chip preview', () => {
	const realMatchMedia = window.matchMedia
	beforeEach(() => {
		window.matchMedia = ((query: string) => ({
			matches: true,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia
		useLinkedChat.mockReturnValue(chat())
	})
	afterEach(() => {
		window.matchMedia = realMatchMedia
	})

	it('opens the chat card on hover with Copy link and Open, and closes it on Escape', async () => {
		const user = userEvent.setup()
		render(<ChatReferenceChip workspaceId={WS} chatId={CHAT} fallback={fallback} />)
		await user.hover(screen.getByRole('link', { name: 'Chat: Launch plan' }))
		const preview = document.querySelector('[data-linked-preview]')
		expect(preview?.textContent).toContain('Forge: Shipped the fix')
		expect(screen.getByRole('dialog', { name: 'Object preview' })).toBe(preview)
		expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument()
		await user.keyboard('{Escape}')
		expect(document.querySelector('[data-linked-preview]')).toBeNull()
	})
})
