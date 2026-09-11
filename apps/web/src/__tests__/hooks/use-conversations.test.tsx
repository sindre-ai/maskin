import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			updateMe: vi.fn(),
		},
	},
}))

import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

// Signal that resolves as soon as onMutate's optimistic patch has been applied;
// the mutationFn awaits it, so we can snapshot the cache between patch and
// settle.
function makeGate() {
	let capture: (v: unknown) => void = () => {}
	const capturePromise = new Promise((res) => (capture = res))
	let release: (v: unknown) => void = () => {}
	const releasePromise = new Promise((res) => (release = res))
	return { capture, capturePromise, release, releasePromise }
}

function seedList(client: QueryClient) {
	const key = queryKeys.conversations.listInfinite('ws-1', undefined)
	client.setQueryData(key, {
		pageParams: [0],
		pages: [
			{
				conversations: [
					{
						id: 'conv-1',
						workspaceId: 'ws-1',
						title: 'Billing retries',
						createdBy: 'me',
						lastMessageAt: null,
						createdAt: null,
						updatedAt: null,
						pinned: false,
						archived: false,
						unread_count: 3,
						snippet: null,
						snippet_actor_id: null,
						snippet_actor_name: null,
						participants: [],
					},
				],
				has_more: false,
			},
		],
	})
	return key
}

function wrapperFactory(client: QueryClient) {
	return ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client }, children)
}

function readUnreadCount(client: QueryClient, key: readonly unknown[]) {
	const snap = client.getQueryData(key) as
		| { pages: { conversations: { id: string; unread_count: number }[] }[] }
		| undefined
	return snap?.pages[0]?.conversations[0]?.unread_count
}

describe('useUpdateConversationMe — onMutate optimistic behavior', () => {
	beforeEach(() => vi.clearAllMocks())

	it('leaves unread_count alone when last_read_message_id: 0 (mark-unread) — no flicker', async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
		})
		const listKey = seedList(client)
		const gate = makeGate()
		// mutationFn signals it started, then awaits `release` so we can inspect
		// the optimistic cache before onSettled invalidates.
		vi.mocked(api.conversations.updateMe).mockImplementation(async () => {
			gate.capture(true)
			await gate.releasePromise
			return { pinned: false, archived: false, last_read_message_id: null }
		})

		const { result } = renderHook(() => useUpdateConversationMe('ws-1'), {
			wrapper: wrapperFactory(client),
		})

		result.current.mutate({ id: 'conv-1', data: { last_read_message_id: 0 } })

		await gate.capturePromise
		await waitFor(() => expect(readUnreadCount(client, listKey)).toBe(3))
		gate.release(true)
	})

	it('zeroes unread_count optimistically for a genuine read-marker advance', async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
		})
		const listKey = seedList(client)
		const gate = makeGate()
		vi.mocked(api.conversations.updateMe).mockImplementation(async () => {
			gate.capture(true)
			await gate.releasePromise
			return { pinned: false, archived: false, last_read_message_id: null }
		})

		const { result } = renderHook(() => useUpdateConversationMe('ws-1'), {
			wrapper: wrapperFactory(client),
		})

		result.current.mutate({ id: 'conv-1', data: { last_read_message_id: 42 } })

		await gate.capturePromise
		await waitFor(() => expect(readUnreadCount(client, listKey)).toBe(0))
		gate.release(true)
	})
})
