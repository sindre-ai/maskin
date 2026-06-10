import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
		sessions: { create: vi.fn() },
		events: { create: vi.fn() },
		relationships: { create: vi.fn() },
	},
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackBetCreated: vi.fn(),
		trackBetStatusChanged: vi.fn(),
		trackBetArchived: vi.fn(),
		trackAgentSessionStarted: vi.fn(),
		trackCommentPosted: vi.fn(),
		trackRelationshipCreated: vi.fn(),
		trackEvent: vi.fn(),
	}
})

import {
	trackAgentSessionStarted,
	trackBetArchived,
	trackBetCreated,
	trackBetStatusChanged,
	trackCommentPosted,
	trackEvent,
	trackRelationshipCreated,
} from '@/lib/analytics'

import { useCreateComment } from '@/hooks/use-events'
import { useCreateObject, useDeleteObject, useUpdateObject } from '@/hooks/use-objects'
import { useCreateRelationship } from '@/hooks/use-relationships'
import { useCreateSession } from '@/hooks/use-sessions'
import type { ObjectResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

const workspaceId = 'ws-1'

function buildObject(overrides: Partial<ObjectResponse> & { id: string }): ObjectResponse {
	return {
		workspaceId,
		type: 'task',
		title: null,
		content: null,
		status: 'todo',
		metadata: null,
		owner: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

function makeWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 1000 * 60 },
			mutations: { retry: false },
		},
	})
	const Wrapper = ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client: queryClient }, children)
	return { queryClient, Wrapper }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useCreateObject — bet_created', () => {
	it('emits bet_created only for bets', async () => {
		vi.mocked(api.objects.create).mockResolvedValue(buildObject({ id: 'bet-1', type: 'bet' }))
		const { Wrapper } = makeWrapper()
		const { result } = renderHook(() => useCreateObject(workspaceId), { wrapper: Wrapper })

		result.current.mutate({ type: 'bet', title: 'New bet', status: 'signal' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackBetCreated).toHaveBeenCalledTimes(1)
		expect(trackBetCreated).toHaveBeenCalledWith({ entity_id: 'bet-1', entity_type: 'bet' })
	})

	it('does not emit bet_created for tasks or insights', async () => {
		vi.mocked(api.objects.create).mockResolvedValue(buildObject({ id: 'task-1', type: 'task' }))
		const { Wrapper } = makeWrapper()
		const { result } = renderHook(() => useCreateObject(workspaceId), { wrapper: Wrapper })

		result.current.mutate({ type: 'task', title: 'New', status: 'todo' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackBetCreated).not.toHaveBeenCalled()
	})
})

describe('useUpdateObject — bet_status_changed', () => {
	it('emits bet_status_changed when status moves on a bet, with prev status from cache', async () => {
		const { Wrapper, queryClient } = makeWrapper()
		const cached = buildObject({ id: 'bet-1', type: 'bet', status: 'define' })
		queryClient.setQueryData(queryKeys.objects.detail('bet-1'), cached)
		vi.mocked(api.objects.update).mockResolvedValue({ ...cached, status: 'active' })

		const { result } = renderHook(() => useUpdateObject(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ id: 'bet-1', data: { status: 'active' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackBetStatusChanged).toHaveBeenCalledWith({
			entity_id: 'bet-1',
			entity_type: 'bet',
			from: 'define',
			to: 'active',
		})
	})

	it('does not emit when status is unchanged or absent from the patch', async () => {
		const { Wrapper, queryClient } = makeWrapper()
		const cached = buildObject({ id: 'bet-1', type: 'bet', status: 'active' })
		queryClient.setQueryData(queryKeys.objects.detail('bet-1'), cached)
		vi.mocked(api.objects.update).mockResolvedValue(cached)

		const { result } = renderHook(() => useUpdateObject(workspaceId), { wrapper: Wrapper })
		result.current.mutate({ id: 'bet-1', data: { title: 'rename' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackBetStatusChanged).not.toHaveBeenCalled()
	})
})

describe('useDeleteObject — bet_archived', () => {
	it('emits bet_archived using the cached type to gate on bets only', async () => {
		const { Wrapper, queryClient } = makeWrapper()
		queryClient.setQueryData(
			queryKeys.objects.detail('bet-1'),
			buildObject({ id: 'bet-1', type: 'bet' }),
		)
		vi.mocked(api.objects.delete).mockResolvedValue({ id: 'bet-1' } as never)

		const { result } = renderHook(() => useDeleteObject(workspaceId), { wrapper: Wrapper })
		result.current.mutate('bet-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackBetArchived).toHaveBeenCalledWith({ entity_id: 'bet-1', entity_type: 'bet' })
	})

	it('skips bet_archived for non-bet deletes', async () => {
		const { Wrapper, queryClient } = makeWrapper()
		queryClient.setQueryData(
			queryKeys.objects.detail('task-1'),
			buildObject({ id: 'task-1', type: 'task' }),
		)
		vi.mocked(api.objects.delete).mockResolvedValue({ id: 'task-1' } as never)

		const { result } = renderHook(() => useDeleteObject(workspaceId), { wrapper: Wrapper })
		result.current.mutate('task-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackBetArchived).not.toHaveBeenCalled()
	})
})

describe('useCreateSession — agent_session_started', () => {
	it('emits agent_session_started with the new session id', async () => {
		vi.mocked(api.sessions.create).mockResolvedValue({
			id: 'sess-9',
			workspaceId,
			actorId: 'agent-1',
			triggerId: null,
			status: 'pending',
			containerId: null,
			actionPrompt: 'do thing',
			config: null,
			result: null,
			snapshotPath: null,
			startedAt: null,
			completedAt: null,
			timeoutAt: null,
			createdBy: 'human-1',
			createdAt: null,
			updatedAt: null,
			currentActivity: null,
		})
		const { Wrapper } = makeWrapper()
		const { result } = renderHook(() => useCreateSession(workspaceId), { wrapper: Wrapper })

		result.current.mutate({ actor_id: 'agent-1', action_prompt: 'do thing' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackAgentSessionStarted).toHaveBeenCalledWith({
			entity_id: 'sess-9',
			entity_type: 'session',
		})
	})
})

describe('useCreateComment — comment_posted', () => {
	it('emits comment_posted with is_reply and attachment_count derived from variables', async () => {
		vi.mocked(api.events.create).mockResolvedValue({} as never)
		const { Wrapper, queryClient } = makeWrapper()
		queryClient.setQueryData(
			queryKeys.objects.detail('bet-1'),
			buildObject({ id: 'bet-1', type: 'bet' }),
		)
		const { result } = renderHook(() => useCreateComment(workspaceId, 'bet-1'), {
			wrapper: Wrapper,
		})

		result.current.mutate({ entity_id: 'bet-1', content: 'hi', parent_event_id: 42 })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackCommentPosted).toHaveBeenCalledWith({
			entity_id: 'bet-1',
			entity_type: 'bet',
			is_reply: true,
			attachment_count: 0,
			flow_id: null,
		})
	})
})

describe('useCreateRelationship — relationship_created + object_attached_file', () => {
	it('emits relationship_created on every successful create', async () => {
		vi.mocked(api.relationships.create).mockResolvedValue({
			id: 'rel-1',
			sourceType: 'object',
			sourceId: 'bet-1',
			targetType: 'object',
			targetId: 'task-2',
			type: 'breaks_into',
			createdBy: 'actor-1',
			createdAt: null,
		})
		const { Wrapper } = makeWrapper()
		const { result } = renderHook(() => useCreateRelationship(workspaceId, 'bet-1'), {
			wrapper: Wrapper,
		})

		result.current.mutate({
			source_type: 'object',
			source_id: 'bet-1',
			target_type: 'object',
			target_id: 'task-2',
			type: 'breaks_into',
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackRelationshipCreated).toHaveBeenCalledWith({
			entity_id: 'rel-1',
			entity_type: 'relationship',
			relationship_type: 'breaks_into',
		})
		expect(trackEvent).not.toHaveBeenCalled()
	})

	it('also emits object_attached_file when an attached edge targets a file', async () => {
		vi.mocked(api.relationships.create).mockResolvedValue({
			id: 'rel-2',
			sourceType: 'bet',
			sourceId: 'bet-1',
			targetType: 'file',
			targetId: 'file-9',
			type: 'attached',
			createdBy: 'actor-1',
			createdAt: null,
		})
		const { Wrapper } = makeWrapper()
		const { result } = renderHook(() => useCreateRelationship(workspaceId, 'bet-1'), {
			wrapper: Wrapper,
		})

		result.current.mutate({
			source_type: 'bet',
			source_id: 'bet-1',
			target_type: 'file',
			target_id: 'file-9',
			type: 'attached',
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(trackRelationshipCreated).toHaveBeenCalledTimes(1)
		expect(trackEvent).toHaveBeenCalledWith(
			'object_attached_file',
			expect.objectContaining({
				entity_id: 'bet-1',
				entity_type: 'bet',
				file_id: 'file-9',
				parent_entity_type: 'bet',
				flow_id: 'rel-2',
			}),
		)
	})
})
