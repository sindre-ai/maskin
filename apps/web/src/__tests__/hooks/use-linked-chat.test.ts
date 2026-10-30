import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useConversationsInfinite = vi.fn()
const useConversation = vi.fn()

vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: (...args: unknown[]) => useConversationsInfinite(...args),
}))
vi.mock('@/hooks/use-conversation', () => ({
	useConversation: (...args: unknown[]) => useConversation(...args),
}))

import { useLinkedChat } from '@/hooks/use-linked-chat'
import { ApiError } from '@/lib/api'

const WS = 'ws-1'
const CHAT = 'c1'
const ada = { actorId: 'a', actorName: 'Ada', actorType: 'human', joinedAt: null, addedBy: null }

function listRow(overrides: Record<string, unknown> = {}) {
	return {
		id: CHAT,
		workspaceId: WS,
		title: 'Launch plan',
		createdBy: 'a',
		lastMessageAt: '2026-10-28T10:00:00Z',
		createdAt: '2026-10-01T10:00:00Z',
		updatedAt: '2026-10-27T10:00:00Z',
		pinned: true,
		archived: false,
		unread_count: 4,
		snippet: 'Shipped it',
		snippet_actor_id: 'a',
		snippet_actor_name: 'Ada',
		participants: [ada],
		...overrides,
	}
}

const list = (...rows: unknown[]) => ({
	isLoading: false,
	data: { pages: [{ conversations: rows, has_more: false }] },
})

beforeEach(() => {
	useConversationsInfinite.mockReset()
	useConversation.mockReset()
	useConversation.mockReturnValue({ data: undefined, error: null, isLoading: false })
})

describe('useLinkedChat', () => {
	it('reads the chat from the loaded list, with its last message, and skips the read by id', () => {
		useConversationsInfinite.mockReturnValue(list(listRow()))
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(result.current).toMatchObject({
			id: CHAT,
			title: 'Launch plan',
			pinned: true,
			archived: false,
			updatedAt: '2026-10-28T10:00:00Z',
			lastMessage: { text: 'Shipped it', authorId: 'a', authorName: 'Ada' },
		})
		expect(useConversation).toHaveBeenCalledWith(CHAT, WS, { enabled: false })
	})

	it('shares the sidebar list entry, and never carries the unread count', () => {
		useConversationsInfinite.mockReturnValue(list(listRow()))
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(useConversationsInfinite).toHaveBeenCalledWith(WS, {})
		expect(JSON.stringify(result.current)).not.toContain('unread')
	})

	it('has no last message for an empty chat', () => {
		useConversationsInfinite.mockReturnValue(list(listRow({ snippet: null })))
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(result.current).toMatchObject({ title: 'Launch plan', lastMessage: null })
	})

	it('is loading while the list loads, and does not read by id yet', () => {
		useConversationsInfinite.mockReturnValue({ isLoading: true, data: undefined })
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(result.current).toBeUndefined()
		expect(useConversation).toHaveBeenCalledWith(CHAT, WS, { enabled: false })
	})

	it('reads by id when the chat is not in the loaded list, and shows it without a last message', () => {
		useConversationsInfinite.mockReturnValue(list(listRow({ id: 'other' })))
		useConversation.mockReturnValue({
			isLoading: false,
			error: null,
			data: {
				id: CHAT,
				workspaceId: WS,
				title: 'Old chat',
				lastMessageAt: null,
				updatedAt: '2026-09-01T10:00:00Z',
				pinned: false,
				archived: true,
				participants: [ada],
			},
		})
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(useConversation).toHaveBeenCalledWith(CHAT, WS, { enabled: true })
		expect(result.current).toMatchObject({
			title: 'Old chat',
			archived: true,
			updatedAt: '2026-09-01T10:00:00Z',
			lastMessage: null,
		})
	})

	it('is loading while the read by id is in flight', () => {
		useConversationsInfinite.mockReturnValue(list())
		useConversation.mockReturnValue({ data: undefined, error: null, isLoading: true })
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(result.current).toBeUndefined()
	})

	it('is null when the read by id is refused or not found, whichever it was', () => {
		useConversationsInfinite.mockReturnValue(list())
		for (const status of [403, 404]) {
			useConversation.mockReturnValue({
				data: undefined,
				isLoading: false,
				error: new ApiError(status, 'nope'),
			})
			const { result } = renderHook(() => useLinkedChat(WS, CHAT))
			expect(result.current).toBeNull()
		}
	})

	it('says nothing about a chat when the server or the network fails', () => {
		useConversationsInfinite.mockReturnValue(list())
		useConversation.mockReturnValue({
			data: undefined,
			isLoading: false,
			error: new ApiError(500, 'boom'),
		})
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(result.current).toBeUndefined()
	})

	it('is null for a chat that belongs to another workspace', () => {
		useConversationsInfinite.mockReturnValue(list())
		useConversation.mockReturnValue({
			isLoading: false,
			error: null,
			data: { id: CHAT, workspaceId: 'ws-2', title: 'x', participants: [] },
		})
		const { result } = renderHook(() => useLinkedChat(WS, CHAT))
		expect(result.current).toBeNull()
	})
})
