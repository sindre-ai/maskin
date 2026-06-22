import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		events: {
			history: vi.fn(),
			create: vi.fn(),
		},
	},
}))

const trackAgentCommentPosted = vi.fn()
const trackCommentPosted = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackAgentCommentPosted: (...args: unknown[]) => trackAgentCommentPosted(...args),
	trackCommentPosted: (...args: unknown[]) => trackCommentPosted(...args),
}))

import {
	trackCommentPostedFor,
	useCreateComment,
	useEntityEvents,
	useEvents,
} from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { buildObjectResponse } from '../factories'
import { TestWrapper, createTestQueryClient } from '../setup'

const workspaceId = 'ws-1'

function buildEvent(overrides: Partial<EventResponse> & { id: number }): EventResponse {
	return {
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		action: 'created',
		entityType: 'object',
		entityId: 'obj-1',
		data: null,
		createdAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useEvents', () => {
	it('fetches events for workspace', async () => {
		const mockEvents = [
			buildEvent({ id: 1, action: 'created' }),
			buildEvent({ id: 2, action: 'updated' }),
		]
		vi.mocked(api.events.history).mockResolvedValue(mockEvents)

		const { result } = renderHook(() => useEvents(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockEvents)
		expect(api.events.history).toHaveBeenCalledWith(workspaceId, undefined)
	})

	it('passes filters to API call', async () => {
		vi.mocked(api.events.history).mockResolvedValue([])
		const filters = { entity_type: 'object', limit: '10' }

		const { result } = renderHook(() => useEvents(workspaceId, filters), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.events.history).toHaveBeenCalledWith(workspaceId, filters)
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.events.history).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useEvents(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error?.message).toBe('Network error')
	})
})

describe('useEntityEvents', () => {
	it('fetches events for entity', async () => {
		const mockEvents = [buildEvent({ id: 1, entityId: 'obj-1' })]
		vi.mocked(api.events.history).mockResolvedValue(mockEvents)

		const { result } = renderHook(() => useEntityEvents(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockEvents)
		expect(api.events.history).toHaveBeenCalledWith(workspaceId, {
			entity_id: 'obj-1',
			limit: '50',
		})
	})

	it('is not enabled when entityId is empty', async () => {
		const { result } = renderHook(() => useEntityEvents(workspaceId, ''), {
			wrapper: TestWrapper,
		})

		expect(result.current.isFetching).toBe(false)
		expect(api.events.history).not.toHaveBeenCalled()
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.events.history).mockRejectedValue(new Error('Server error'))

		const { result } = renderHook(() => useEntityEvents(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Server error')
	})
})

describe('useCreateComment', () => {
	it('calls api.events.create with workspace and data', async () => {
		const newEvent = buildEvent({ id: 3, action: 'commented', entityId: 'obj-1' })
		vi.mocked(api.events.create).mockResolvedValue(newEvent)

		const { result } = renderHook(() => useCreateComment(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ entity_id: 'obj-1', content: 'Nice work!' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.events.create).toHaveBeenCalledWith(workspaceId, {
			entity_id: 'obj-1',
			content: 'Nice work!',
		})
	})

	describe('trackCommentPostedFor (agent_comment_posted)', () => {
		it('emits has_chart=true when content includes a ```chart fenced block', () => {
			const qc = createTestQueryClient()
			const obj = buildObjectResponse({ id: 'obj-1', type: 'bet' })
			qc.setQueryData(queryKeys.objects.detail('obj-1'), obj)

			trackCommentPostedFor(
				qc,
				'obj-1',
				{
					entity_id: 'obj-1',
					content:
						'header\n\n```chart\n{"type":"bar","x":"d","series":["v"],"data":[{"d":"1","v":1}]}\n```',
				},
				null,
			)

			expect(trackAgentCommentPosted).toHaveBeenCalledWith(
				expect.objectContaining({
					entity_id: 'obj-1',
					entity_type: 'bet',
					has_chart: true,
					has_task_list: false,
					has_visual: true,
					is_reply: false,
				}),
			)
		})

		it('emits has_task_list=true when metadata.tasks has any string id', () => {
			const qc = createTestQueryClient()
			const obj = buildObjectResponse({ id: 'obj-1', type: 'task' })
			qc.setQueryData(queryKeys.objects.detail('obj-1'), obj)

			trackCommentPostedFor(
				qc,
				'obj-1',
				{
					entity_id: 'obj-1',
					content: 'tracking',
					metadata: { tasks: ['11111111-1111-1111-1111-111111111111'] },
					parent_event_id: 99,
				},
				null,
			)

			expect(trackAgentCommentPosted).toHaveBeenCalledWith(
				expect.objectContaining({
					entity_type: 'task',
					has_chart: false,
					has_task_list: true,
					has_visual: true,
					is_reply: true,
					char_count: 'tracking'.length,
				}),
			)
		})

		it('emits has_visual=false for plain text replies', () => {
			const qc = createTestQueryClient()
			const obj = buildObjectResponse({ id: 'obj-1', type: 'insight' })
			qc.setQueryData(queryKeys.objects.detail('obj-1'), obj)

			trackCommentPostedFor(
				qc,
				'obj-1',
				{
					entity_id: 'obj-1',
					content: 'just words',
				},
				null,
			)

			expect(trackAgentCommentPosted).toHaveBeenCalledWith(
				expect.objectContaining({
					has_chart: false,
					has_task_list: false,
					has_visual: false,
				}),
			)
		})

		it('does not emit when the cached object type is not a comment-able object', () => {
			const qc = createTestQueryClient()
			trackCommentPostedFor(qc, 'obj-unknown', { entity_id: 'obj-unknown', content: 'plain' }, null)
			expect(trackAgentCommentPosted).not.toHaveBeenCalled()
		})
	})

	it('exposes error when create fails', async () => {
		vi.mocked(api.events.create).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useCreateComment(workspaceId, 'obj-1'), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ entity_id: 'obj-1', content: 'Bad' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Forbidden')
	})
})
