import type { ConversationListItemResponse } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: { list: vi.fn(), replyThreads: vi.fn(), messages: vi.fn(), updateMe: vi.fn() },
		search: { query: vi.fn() },
	},
}))

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { ConversationList } from '@/components/chat/conversation-list'
import { api } from '@/lib/api'

function buildConversation(
	overrides: Partial<ConversationListItemResponse> = {},
): ConversationListItemResponse {
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
		unread_count: 0,
		snippet: 'Still open on three accounts.',
		snippet_actor_id: null,
		snippet_actor_name: null,
		working_actor_ids: [],
		participants: [],
		...overrides,
	}
}

/** Answers the default list's two fetches: the priority set (DMs, pinned, unread) and the recent rest. */
function mockScopedList({
	priority = [],
	priorityPages,
	recent,
	recentHasMore = false,
}: {
	priority?: ConversationListItemResponse[]
	/** Overrides `priority`: one array per page, the last page closing the set. */
	priorityPages?: ConversationListItemResponse[][]
	recent: ConversationListItemResponse[]
	recentHasMore?: boolean
}) {
	const pages = priorityPages ?? [priority]
	vi.mocked(api.conversations.list).mockImplementation(async (_ws, params) => {
		if (params?.scope === 'priority') {
			const page = Number(params.offset) / Number(params.limit)
			return { conversations: pages[page] ?? [], has_more: page < pages.length - 1 }
		}
		return { conversations: recent, has_more: recentHasMore }
	})
}

describe('ConversationList', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.list).mockReset()
		vi.mocked(api.conversations.replyThreads).mockReset()
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [] } as never)
	})

	it('renders the group rail and closes the list with the end-of-history line when there is no next page', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [
				buildConversation({ id: 'a', title: 'Billing retries' }),
				buildConversation({ id: 'b', title: 'Second one' }),
			],
			has_more: false,
		})
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Earlier')).toBeInTheDocument()
		expect(screen.getByText("That's the whole history — 2 in this workspace.")).toBeInTheDocument()
		// The scroll affordance never renders alongside the closing line.
		expect(screen.queryByText(/Older conversations load as you scroll/)).not.toBeInTheDocument()
	})

	it('loads every direct message, pinned and unread chat, and only the newest 20 of the rest', async () => {
		const dms = Array.from({ length: 3 }, (_, i) =>
			buildConversation({ id: `dm-${i}`, title: `Agent ${i}`, directPairKey: `pair-${i}` }),
		)
		const pinned = buildConversation({ id: 'pin', title: 'Pinned chat', pinned: true })
		const unread = buildConversation({ id: 'unr', title: 'Unread chat', unread_count: 4 })
		// Priority streams in over two pages; the list must wait for both before it shows counts.
		mockScopedList({
			priorityPages: [[...dms, pinned], [unread]],
			recent: [buildConversation({ id: 'old', title: 'Old chat' })],
			recentHasMore: true,
		})
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByRole('button', { name: /Unread\s*1/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Direct messages\s*3/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Pinned\s*1/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Earlier\s*1/ })).toBeInTheDocument()
		const calls = vi.mocked(api.conversations.list).mock.calls.map(([, q]) => q)
		expect(calls).toContainEqual(expect.objectContaining({ scope: 'recent', limit: '20' }))
		expect(calls).toContainEqual(expect.objectContaining({ scope: 'priority', offset: '100' }))
	})

	it('hides the end-of-history line while more pages remain', async () => {
		mockScopedList({ recent: [buildConversation({ id: 'a' })], recentHasMore: true })
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		// The scroll sentinel owns the tail while pages are still fetchable —
		// showing "That's the whole history" here would lie about the count.
		expect(await screen.findByText(/Older conversations load as you scroll/)).toBeInTheDocument()
		expect(screen.queryByText(/whole history/)).not.toBeInTheDocument()
	})

	it('advertises the scroll affordance only while another page is pending', async () => {
		mockScopedList({ recent: [buildConversation({ id: 'a' })], recentHasMore: true })
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		// The sentinel only claims to be loading while a page is actually in
		// flight; idle it advertises the scroll affordance (mockup 545–549).
		expect(await screen.findByText(/Older conversations load as you scroll/)).toBeInTheDocument()
	})

	it('shows the archived-specific empty copy when the archived filter matches nothing', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		render(<ConversationList workspaceId="ws-1" filter="archived" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Nothing archived yet')).toBeInTheDocument()
		// A new chat is never archived, so offering one here sends the reader
		// somewhere this list will still not show it (mockup 542–544).
		expect(screen.queryByRole('link', { name: 'Start a new one →' })).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'View all chats →' })).toBeInTheDocument()
	})

	it('shows the Start a new one link in the empty list, and hides it when asked to', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		const { unmount } = render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(await screen.findByRole('link', { name: 'Start a new one →' })).toBeInTheDocument()
		unmount()

		render(<ConversationList workspaceId="ws-1" hideStartLink />, { wrapper: TestWrapper })
		expect(await screen.findByText('No chats yet')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: 'Start a new one →' })).not.toBeInTheDocument()
	})

	it('shows the generic empty copy for a filter with no matches', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		render(<ConversationList workspaceId="ws-1" filter="pinned" />, { wrapper: TestWrapper })

		expect(await screen.findByText('No conversations here')).toBeInTheDocument()
	})

	it('sends the matching query param for each filter', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		const { unmount } = render(<ConversationList workspaceId="ws-1" filter="unread" />, {
			wrapper: TestWrapper,
		})
		await waitFor(() =>
			expect(api.conversations.list).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ unread_only: 'true' }),
			),
		)
		unmount()

		vi.mocked(api.conversations.list).mockClear()
		render(<ConversationList workspaceId="ws-1" filter="pinned" />, { wrapper: TestWrapper })
		await waitFor(() =>
			expect(api.conversations.list).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ pinned: 'true' }),
			),
		)
	})

	it('keeps a row in the Unread filter once it is read, until the filter changes', async () => {
		vi.mocked(api.conversations.list).mockResolvedValueOnce({
			conversations: [
				buildConversation({ id: 'a', title: 'First unread', unread_count: 2 }),
				buildConversation({ id: 'b', title: 'Second unread', unread_count: 1 }),
			],
			has_more: false,
		})
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		)
		const view = render(<ConversationList workspaceId="ws-1" filter="unread" />, { wrapper })
		expect(await screen.findByText('First unread')).toBeInTheDocument()

		// Reading the first chat makes the server drop it from the unread list.
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [buildConversation({ id: 'b', title: 'Second unread', unread_count: 1 })],
			has_more: false,
		})
		await act(async () => {
			await client.invalidateQueries()
		})
		expect(screen.getByText('First unread')).toBeInTheDocument()
		expect(screen.getByText('Second unread')).toBeInTheDocument()

		// Leaving the filter and coming back starts from the server's list.
		view.rerender(<ConversationList workspaceId="ws-1" filter="all" />)
		view.rerender(<ConversationList workspaceId="ws-1" filter="unread" />)
		await waitFor(() => expect(screen.queryByText('First unread')).not.toBeInTheDocument())
		expect(screen.getByText('Second unread')).toBeInTheDocument()
	})

	it('keeps server order in the Unread filter after Load more, with a read row in its place', async () => {
		let firstPage = [
			buildConversation({ id: 'a', title: 'Row A', unread_count: 1 }),
			buildConversation({ id: 'b', title: 'Row B', unread_count: 1 }),
		]
		const secondPage = [
			buildConversation({ id: 'c', title: 'Row C', unread_count: 1 }),
			buildConversation({ id: 'd', title: 'Row D', unread_count: 1 }),
		]
		vi.mocked(api.conversations.list).mockImplementation(async (_ws, params) =>
			params?.offset === '0'
				? { conversations: firstPage, has_more: true }
				: { conversations: secondPage, has_more: false },
		)
		// Drive the scroll sentinel so the second page loads.
		let intersect: (() => void) | undefined
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
					intersect = () => cb([{ isIntersecting: true }])
				}
				observe() {}
				unobserve() {}
				disconnect() {}
				takeRecords() {
					return []
				}
			},
		)
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		)
		const titles = () => screen.getAllByText(/^Row [A-D]$/).map((el) => el.textContent)
		try {
			render(<ConversationList workspaceId="ws-1" filter="unread" />, { wrapper })
			expect(await screen.findByText('Row A')).toBeInTheDocument()

			await act(async () => {
				intersect?.()
			})
			expect(await screen.findByText('Row D')).toBeInTheDocument()
			// The later page lands below the rows already shown.
			expect(titles()).toEqual(['Row A', 'Row B', 'Row C', 'Row D'])

			// Reading A drops it from the server's list; it stays where it was.
			firstPage = [firstPage[1]]
			await act(async () => {
				await client.invalidateQueries()
			})
			expect(titles()).toEqual(['Row A', 'Row B', 'Row C', 'Row D'])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('collapses archived results into a single Archived group', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [
				buildConversation({ id: 'a', archived: true }),
				buildConversation({ id: 'b', archived: true, pinned: true, title: 'Pinned one' }),
			],
			has_more: false,
		})
		render(<ConversationList workspaceId="ws-1" filter="archived" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Archived')).toBeInTheDocument()
		expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
	})

	it('shows a retryable error rather than the empty state when the fetch fails', async () => {
		// A failed fetch used to collapse into `[]` and render "No conversations
		// here — start a chat", which reads as an empty account and invites the
		// reader to duplicate a thread they already have.
		vi.mocked(api.conversations.list).mockRejectedValue(new Error('network down'))
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText("Couldn't load chats")).toBeInTheDocument()
		expect(screen.queryByText('No conversations here')).not.toBeInTheDocument()

		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [buildConversation({ id: 'a', title: 'Billing retries' })],
			has_more: false,
		})
		screen.getByRole('button', { name: /Try again/ }).click()
		expect(await screen.findByText('Billing retries')).toBeInTheDocument()
	})

	it('flags a chat whose threads hold unread replies', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [buildConversation({ id: 'a', title: 'Billing retries' })],
			has_more: false,
		})
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({
			threads: [
				{ conversationId: 'a', thread: { unreadCount: 1 } },
				{ conversationId: 'a', thread: { unreadCount: 2 } },
			],
		} as never)
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('3 unread replies in threads')).toBeInTheDocument()
	})

	it('marks the Unread group read, keeps the successes when one chat fails, and says how many failed', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [
				buildConversation({ id: 'ok', title: 'Fine one', unread_count: 2 }),
				buildConversation({ id: 'bad', title: 'Broken one', unread_count: 1 }),
				buildConversation({ id: 'pin', title: 'Pinned one', unread_count: 3, pinned: true }),
			],
			has_more: false,
		})
		vi.mocked(api.conversations.messages).mockImplementation(async (id: string) => {
			if (id === 'bad') throw new Error('boom')
			return { messages: [{ id: 7 }], has_more: false } as never
		})
		vi.mocked(api.conversations.updateMe).mockResolvedValue({} as never)
		toastError.mockClear()
		render(<ConversationList workspaceId="ws-1" filter="unread" />, { wrapper: TestWrapper })

		await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }))

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
		expect(toastError.mock.calls[0]?.[0]).toContain('1 chat')
		// The good chat was marked; the pinned one is not in the Unread group, so it was left alone.
		expect(api.conversations.updateMe).toHaveBeenCalledTimes(1)
		expect(api.conversations.updateMe).toHaveBeenCalledWith('ok', 'ws-1', {
			last_read_message_id: 7,
		})
		expect(api.conversations.messages).not.toHaveBeenCalledWith('pin', expect.anything())
	})
})

describe('ConversationList collapse', () => {
	it('hides every direct message row when the Direct messages group is collapsed', async () => {
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [] } as never)
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: Array.from({ length: 21 }, (_, i) =>
				buildConversation({ id: `dm-${i}`, title: `Agent ${i}`, directPairKey: `pair-${i}` }),
			),
			has_more: false,
		})
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })
		const header = await screen.findByRole('button', { name: /Direct messages/ })
		expect(screen.getAllByRole('link')).toHaveLength(21)
		await userEvent.click(header)
		expect(screen.queryAllByRole('link')).toHaveLength(0)
	})

	it('keeps rows hidden and stops paging while every group is collapsed', async () => {
		const live = new Set<() => void>()
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
					this.fire = () => cb([{ isIntersecting: true }])
				}
				fire: () => void
				observe() {
					live.add(this.fire)
				}
				disconnect() {
					live.delete(this.fire)
				}
			},
		)
		const dm = (i: number) =>
			buildConversation({ id: `dm-${i}`, title: `Agent ${i}`, directPairKey: `pair-${i}` })
		mockScopedList({
			priority: Array.from({ length: 13 }, (_, i) => dm(i)),
			recent: [],
			recentHasMore: true,
		})
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })
		await userEvent.click(await screen.findByRole('button', { name: /Direct messages/ }))
		for (const fire of live) fire()
		expect(vi.mocked(api.conversations.list).mock.calls.some(([, q]) => q?.offset === '20')).toBe(
			false,
		)
		expect(screen.queryAllByRole('link')).toHaveLength(0)
		vi.unstubAllGlobals()
	})

	it('lists a chat once when a later page repeats it', async () => {
		const dm = (i: number) =>
			buildConversation({ id: `dm-${i}`, title: `Agent ${i}`, directPairKey: `pair-${i}` })
		vi.mocked(api.conversations.list)
			.mockResolvedValueOnce({ conversations: [dm(0), dm(1)], has_more: true })
			.mockResolvedValue({ conversations: [dm(1), dm(2)], has_more: false })
		const live = new Set<() => void>()
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				fire: () => void
				constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
					this.fire = () => cb([{ isIntersecting: true }])
				}
				observe() {
					live.add(this.fire)
				}
				disconnect() {
					live.delete(this.fire)
				}
			},
		)
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })
		const header = await screen.findByRole('button', { name: /Direct messages/ })
		await act(async () => {
			for (const fire of live) fire()
		})
		await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(3))
		expect(header).toHaveTextContent('3')
		await userEvent.click(header)
		expect(screen.queryAllByRole('link')).toHaveLength(0)
		vi.unstubAllGlobals()
	})
})

describe('ConversationList search', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.list).mockReset()
		vi.mocked(api.conversations.replyThreads).mockReset()
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [] } as never)
		vi.mocked(api.search.query).mockReset()
	})

	function searchRow(overrides: Record<string, unknown> = {}) {
		return {
			id: 'old-1',
			group: 'chats',
			type: 'chat',
			title: 'Invoice export',
			sub: 'Developer, Me',
			snippet: 'the csv export times out',
			status: 'archived',
			statusGroup: 'archived',
			updatedAt: '2026-09-01T10:00:00.000Z',
			...overrides,
		}
	}

	function answer(results: unknown[]) {
		vi.mocked(api.search.query).mockResolvedValue({
			results,
			total: results.length,
			capped: false,
			facets: { types: {}, statuses: {} },
			relaxed: { withoutFilters: 0, withoutStatuses: 0 },
			partial: [],
		} as never)
	}

	it('asks the server for chats and shows an archived hit that the list never loaded', async () => {
		mockScopedList({ recent: [buildConversation({ id: 'a', title: 'Billing retries' })] })
		answer([searchRow()])
		render(<ConversationList workspaceId="ws-1" query="csv" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Invoice export')).toBeInTheDocument()
		expect(api.search.query).toHaveBeenCalledWith(
			'ws-1',
			expect.objectContaining({ q: 'csv', types: 'chat' }),
			expect.anything(),
		)
		expect(screen.getByText('Archived')).toBeInTheDocument()
		expect(screen.getByText('csv', { selector: 'mark' })).toBeInTheDocument()
		// The grouped list steps aside while words are typed.
		expect(screen.queryByText('Billing retries')).not.toBeInTheDocument()
	})

	it('leaves the chip off a chat that is not archived and is in the list', async () => {
		mockScopedList({ recent: [buildConversation({ id: 'old-1', title: 'Invoice export' })] })
		answer([searchRow({ status: 'read', statusGroup: 'done' })])
		render(<ConversationList workspaceId="ws-1" query="csv" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Invoice export')).toBeInTheDocument()
		expect(screen.queryByText('Archived')).not.toBeInTheDocument()
	})

	it('says so when no chat matches', async () => {
		mockScopedList({ recent: [] })
		answer([])
		render(<ConversationList workspaceId="ws-1" query="zzz" />, { wrapper: TestWrapper })

		expect(await screen.findByText('No chats found')).toBeInTheDocument()
	})
})
