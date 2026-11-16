import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		loops: {
			list: vi.fn(),
			activity: vi.fn(),
		},
		relationships: { list: vi.fn() },
		objects: { list: vi.fn() },
	},
}))

import {
	useLoop,
	useLoopActivity,
	useLoopMembership,
	useLoops,
	useObjectsByIds,
} from '@/hooks/use-loops'
import { type EventResponse, type LoopSummary, api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId,
		name: 'Customer feedback',
		content: 'Every customer who gives feedback hears back within 30 days',
		status: 'learning',
		pill: 'learning',
		entryCondition: null,
		closeCondition: null,
		tags: [],
		driverId: null,
		inProgressCount: 3,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
		waitingCount: 0,
		targets: null,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useLoops', () => {
	it('unwraps loops from the list-response envelope', async () => {
		const loops = [buildLoop(), buildLoop({ id: 'loop-2', name: 'Build pipeline' })]
		vi.mocked(api.loops.list).mockResolvedValue({ loops })

		const { result } = renderHook(() => useLoops(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(loops)
		expect(api.loops.list).toHaveBeenCalledWith(workspaceId)
	})

	it('returns an empty array when no loops exist', async () => {
		vi.mocked(api.loops.list).mockResolvedValue({ loops: [] })

		const { result } = renderHook(() => useLoops(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual([])
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.loops.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useLoops(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Network error')
	})
})

describe('useLoop', () => {
	it('finds the matching loop by id from the list', async () => {
		const loops = [buildLoop(), buildLoop({ id: 'loop-2', name: 'Build pipeline' })]
		vi.mocked(api.loops.list).mockResolvedValue({ loops })

		const { result } = renderHook(() => useLoop('loop-2', workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.data).toBeDefined())
		expect(result.current.data?.name).toBe('Build pipeline')
	})

	it('returns undefined when no loop matches the id', async () => {
		vi.mocked(api.loops.list).mockResolvedValue({ loops: [buildLoop()] })

		const { result } = renderHook(() => useLoop('missing', workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeUndefined()
	})
})

describe('useLoopActivity', () => {
	function buildEvent(overrides: Partial<EventResponse> = {}): EventResponse {
		return {
			id: 1,
			workspaceId,
			actorId: 'actor-1',
			action: 'session_completed',
			entityType: 'session',
			entityId: 'session-1',
			data: {},
			createdAt: '2026-08-13T00:00:00.000Z',
			...overrides,
		}
	}

	it('unwraps events from the activity envelope', async () => {
		const events = [buildEvent(), buildEvent({ id: 2, action: 'trigger_fired' })]
		vi.mocked(api.loops.activity).mockResolvedValue({ events })

		const { result } = renderHook(() => useLoopActivity('loop-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(events)
		expect(api.loops.activity).toHaveBeenCalledWith('loop-1', workspaceId)
	})
})

describe('useLoopMembership', () => {
	const edge = (i: number, targetType = 'object') => ({
		id: `edge-${i}`,
		sourceType: 'object',
		sourceId: 'loop-1',
		targetType,
		targetId: `target-${i}`,
		type: 'in_loop',
	})

	it('reads every page of links, not just the first 100', async () => {
		const first = Array.from({ length: 100 }, (_, i) => edge(i))
		const second = Array.from({ length: 43 }, (_, i) => edge(100 + i))
		vi.mocked(api.relationships.list).mockResolvedValueOnce(first as never)
		vi.mocked(api.relationships.list).mockResolvedValueOnce(second as never)

		const { result } = renderHook(() => useLoopMembership(workspaceId, 'loop-1'), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(result.current.data?.itemIds).toHaveLength(143)
		expect(api.relationships.list).toHaveBeenCalledTimes(2)
		expect(vi.mocked(api.relationships.list).mock.calls[1]?.[1]).toMatchObject({
			source_id: 'loop-1',
			type: 'in_loop',
			offset: '100',
		})
	})

	it('keeps attached files apart from items', async () => {
		vi.mocked(api.relationships.list).mockResolvedValueOnce([edge(1), edge(2, 'file')] as never)

		const { result } = renderHook(() => useLoopMembership(workspaceId, 'loop-1'), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(result.current.data).toEqual({ itemIds: ['target-1'], fileIds: ['target-2'] })
	})
})

describe('useObjectsByIds', () => {
	it('fetches ids in pages of 100 and joins them', async () => {
		const ids = Array.from({ length: 230 }, (_, i) => `id-${i}`)
		vi.mocked(api.objects.list).mockImplementation(((
			_ws: string,
			params?: Record<string, string>,
		) => Promise.resolve((params?.ids ?? '').split(',').map((id) => ({ id })))) as never)

		const { result } = renderHook(() => useObjectsByIds(workspaceId, ids), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(api.objects.list).toHaveBeenCalledTimes(3)
		expect(result.current.data).toHaveLength(230)
	})
})
