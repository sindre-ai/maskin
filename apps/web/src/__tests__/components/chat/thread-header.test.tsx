import type {
	ConversationDetailResponse,
	MessageResponse,
	MessagesListResponse,
} from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
const mockTrackNav = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
	useSearch: () => ({ wide: undefined }),
	Link: ({ children, to }: { children: ReactNode; to?: string }) =>
		React.createElement('a', { href: to }, children),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsTouchViewport: () => false,
}))

vi.mock('sonner', () => ({
	toast: { success: mockToastSuccess, error: mockToastError },
}))

vi.mock('@/lib/analytics', () => ({
	trackNavItemClicked: mockTrackNav,
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }),
}))

const mockUpdateMe = vi.fn()

vi.mock('@/hooks/use-conversations', () => ({
	useUpdateConversationMe: () => ({ mutate: mockUpdateMe }),
	useUpdateConversation: () => ({ mutate: vi.fn() }),
}))

const mockUseConversation = vi.fn()
const mockUseConversationMessages = vi.fn()

vi.mock('@/hooks/use-conversation', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-conversation')>(
		'@/hooks/use-conversation',
	)
	return {
		...actual,
		useConversation: (...args: unknown[]) => mockUseConversation(...args),
		useConversationMessages: (...args: unknown[]) => mockUseConversationMessages(...args),
	}
})

const mockUseLoop = vi.fn()

vi.mock('@/hooks/use-loops', () => ({
	useLoop: (...args: unknown[]) => mockUseLoop(...args),
}))

// ParticipantsPopover reaches for router search that isn't set up here — this
// suite doesn't exercise it, so stub it to just render its children.
vi.mock('@/components/chat/participants-popover', () => ({
	ParticipantsPopover: ({ children }: { children: ReactNode }) =>
		React.createElement('div', { 'data-testid': 'participants-popover' }, children),
}))

import { ThreadHeader } from '@/components/chat/thread-header'

function buildConversation(
	overrides: Partial<ConversationDetailResponse> = {},
): ConversationDetailResponse {
	return {
		id: 'conv-1',
		workspaceId: 'ws-1',
		title: 'Billing retries',
		createdBy: 'me',
		lastMessageAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: null,
		pinned: false,
		archived: false,
		last_read_message_id: null,
		participants: [
			{ actorId: 'me', actorName: 'Me', actorType: 'human', joinedAt: null, addedBy: null },
			{
				actorId: 'agent-1',
				actorName: 'Billing Agent',
				actorType: 'agent',
				joinedAt: null,
				addedBy: null,
			},
		],
		...overrides,
	}
}

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'me',
		actorName: 'Me',
		actorType: 'human',
		kind: 'message',
		content: 'Hello',
		metadata: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
		...overrides,
	}
}

// The hook flattens with `.reverse()` — reverse the input once so the fixture
// reads oldest → newest and the transcript preserves that order.
function messagesPages(messages: MessageResponse[]): { pages: MessagesListResponse[] } {
	return { pages: [{ messages: [...messages].reverse(), has_more: false }] }
}

// Only `id` and `name` are read by ThreadHeader; the rest of LoopSummary is
// irrelevant to these assertions, so cast the light-weight shape.
function buildLoop(overrides: { id?: string; name?: string } = {}) {
	return { id: overrides.id ?? 'loop-1', name: overrides.name ?? 'Growth loop' }
}

function TestWrapper({ children }: { children: ReactNode }) {
	const [queryClient] = React.useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
			}),
	)
	return React.createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderHeader() {
	return render(<ThreadHeader workspaceId="ws-1" conversationId="conv-1" />, {
		wrapper: TestWrapper,
	})
}

describe('ThreadHeader — v4 actions', () => {
	beforeEach(() => {
		mockNavigate.mockReset()
		mockToastSuccess.mockReset()
		mockToastError.mockReset()
		mockTrackNav.mockReset()
		mockUpdateMe.mockReset()
		mockUseConversation.mockReset()
		mockUseConversationMessages.mockReset()
		mockUseLoop.mockReset()
		mockUseLoop.mockReturnValue({ data: undefined })
		mockUseConversationMessages.mockReturnValue({ data: messagesPages([]) })
	})

	describe('Loop chip', () => {
		it('renders no chip when the conversation has no loop_id', () => {
			mockUseConversation.mockReturnValue({ data: buildConversation() })
			renderHeader()
			expect(screen.queryByRole('button', { name: /^Loop:/ })).not.toBeInTheDocument()
		})

		it('renders and links to the loop when loop_id is set', async () => {
			mockUseConversation.mockReturnValue({
				data: buildConversation({ loop_id: 'loop-1' }),
			})
			mockUseLoop.mockReturnValue({ data: buildLoop({ id: 'loop-1', name: 'Growth loop' }) })
			renderHeader()

			const chip = screen.getByRole('button', { name: 'Loop: Growth loop' })
			expect(chip).toHaveTextContent('Growth loop')

			await userEvent.click(chip)
			expect(mockTrackNav).toHaveBeenCalledWith({ item_key: 'loop_chip', source: 'top-nav' })
			expect(mockNavigate).toHaveBeenCalledWith(
				expect.objectContaining({
					to: '/$workspaceId/loops/$loopId',
					params: { workspaceId: 'ws-1', loopId: 'loop-1' },
				}),
			)
		})

		it('truncates the loop name past 24 characters', () => {
			mockUseConversation.mockReturnValue({
				data: buildConversation({ loop_id: 'loop-1' }),
			})
			const longName = 'A very long loop name that exceeds twenty four chars'
			mockUseLoop.mockReturnValue({ data: buildLoop({ id: 'loop-1', name: longName }) })
			renderHeader()

			const chip = screen.getByRole('button', { name: `Loop: ${longName}` })
			expect((chip.textContent ?? '').length).toBeLessThanOrEqual(24)
			expect(chip.textContent).toMatch(/…$/)
		})
	})

	describe('Copy whole conversation', () => {
		it('copies user + agent messages and toasts the count', async () => {
			mockUseConversation.mockReturnValue({ data: buildConversation() })
			mockUseConversationMessages.mockReturnValue({
				data: messagesPages([
					buildMessage({ id: 1, content: 'Hey', actorName: 'Me', actorType: 'human' }),
					buildMessage({
						id: 2,
						content: 'Working on it',
						actorName: 'Billing Agent',
						actorType: 'agent',
					}),
					// System rows (resume banner / activity) must not count.
					buildMessage({ id: 3, content: 'system note', kind: 'system' }),
				]),
			})
			const writeText = vi.fn().mockResolvedValue(undefined)
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText },
				configurable: true,
			})
			renderHeader()

			await userEvent.click(screen.getByRole('button', { name: 'Copy whole conversation' }))

			await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
			const copied = writeText.mock.calls[0][0] as string
			expect(copied).toContain('Me: Hey')
			expect(copied).toContain('Billing Agent: Working on it')
			expect(copied).not.toContain('system note')

			expect(mockTrackNav).toHaveBeenCalledWith({
				item_key: 'copy_conversation',
				source: 'top-nav',
			})
			await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Copied 2 messages'))
		})
	})

	describe('Mark as unread', () => {
		it('calls updateMe with last_read_message_id: 0, toasts, and fires analytics', async () => {
			mockUseConversation.mockReturnValue({ data: buildConversation() })
			mockUpdateMe.mockImplementation((_vars, opts) => {
				opts?.onSuccess?.()
			})
			renderHeader()

			await userEvent.click(screen.getByRole('button', { name: 'Mark as unread' }))

			expect(mockUpdateMe).toHaveBeenCalledWith(
				{ id: 'conv-1', data: { last_read_message_id: 0 } },
				expect.any(Object),
			)
			expect(mockTrackNav).toHaveBeenCalledWith({ item_key: 'mark_unread', source: 'top-nav' })
			expect(mockToastSuccess).toHaveBeenCalledWith('Marked as unread')
		})
	})
})
