import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		loops: {
			list: vi.fn(),
			activity: vi.fn(),
		},
		relationships: {
			list: vi.fn(),
		},
	},
}))

import { useObjectLoops } from '@/hooks/use-object-loops'
import { type LoopSummary, type RelationshipResponse, api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId,
		name: 'Customer feedback',
		content: null,
		status: 'learning',
		pill: 'learning',
		entryCondition: null,
		closeCondition: null,
		inProgressCount: 0,
		closedCount: 0,
		medianTimeToCloseMs: null,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z',
		...overrides,
	}
}

function buildEdge(overrides: Partial<RelationshipResponse> = {}): RelationshipResponse {
	return {
		id: 'rel-1',
		sourceType: 'object',
		sourceId: 'loop-1',
		targetType: 'object',
		targetId: 'obj-1',
		type: 'in_loop',
		createdBy: 'actor-1',
		createdAt: '2026-08-02T00:00:00.000Z',
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useObjectLoops', () => {
	it('returns an empty map immediately when no ids are passed', () => {
		const { result } = renderHook(() => useObjectLoops(workspaceId, []), {
			wrapper: TestWrapper,
		})
		expect(result.current.data.size).toBe(0)
		expect(result.current.isLoading).toBe(false)
	})

	it('reverse-indexes the first in_loop edge per object, keyed by object id', async () => {
		vi.mocked(api.loops.list).mockResolvedValue({
			loops: [
				buildLoop({ id: 'loop-1', name: 'signal-triage' }),
				buildLoop({ id: 'loop-2', name: 'build-pipeline' }),
			],
		})
		vi.mocked(api.relationships.list).mockImplementation(async (_ws, params) => {
			if (params?.source_id === 'loop-1') {
				return [
					buildEdge({ sourceId: 'loop-1', targetId: 'obj-1' }),
					buildEdge({ id: 'rel-2', sourceId: 'loop-1', targetId: 'obj-2' }),
				]
			}
			if (params?.source_id === 'loop-2') {
				return [buildEdge({ id: 'rel-3', sourceId: 'loop-2', targetId: 'obj-3' })]
			}
			return []
		})

		const { result } = renderHook(() => useObjectLoops(workspaceId, ['obj-1', 'obj-2', 'obj-3']), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data.get('obj-1')).toEqual({ id: 'loop-1', name: 'signal-triage' })
		expect(result.current.data.get('obj-2')).toEqual({ id: 'loop-1', name: 'signal-triage' })
		expect(result.current.data.get('obj-3')).toEqual({ id: 'loop-2', name: 'build-pipeline' })
	})

	it('shows the first loop deterministically when an object is in multiple loops', async () => {
		vi.mocked(api.loops.list).mockResolvedValue({
			loops: [
				buildLoop({ id: 'loop-first', name: 'first' }),
				buildLoop({ id: 'loop-second', name: 'second' }),
			],
		})
		vi.mocked(api.relationships.list).mockImplementation(async (_ws, params) => {
			// obj-shared is in BOTH loops; iteration order from the /loops list
			// is the tie-breaker.
			if (params?.source_id === 'loop-first') {
				return [buildEdge({ sourceId: 'loop-first', targetId: 'obj-shared' })]
			}
			if (params?.source_id === 'loop-second') {
				return [buildEdge({ id: 'rel-2', sourceId: 'loop-second', targetId: 'obj-shared' })]
			}
			return []
		})

		const { result } = renderHook(() => useObjectLoops(workspaceId, ['obj-shared']), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data.get('obj-shared')).toEqual({ id: 'loop-first', name: 'first' })
	})

	it('falls back to "Loop" when a loop has no name', async () => {
		vi.mocked(api.loops.list).mockResolvedValue({
			loops: [buildLoop({ id: 'loop-1', name: null })],
		})
		vi.mocked(api.relationships.list).mockResolvedValue([
			buildEdge({ sourceId: 'loop-1', targetId: 'obj-1' }),
		])

		const { result } = renderHook(() => useObjectLoops(workspaceId, ['obj-1']), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data.get('obj-1')?.name).toBe('Loop')
	})

	it('reports isError when the loops list fails', async () => {
		vi.mocked(api.loops.list).mockRejectedValue(new Error('boom'))

		const { result } = renderHook(() => useObjectLoops(workspaceId, ['obj-1']), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.data.size).toBe(0)
	})
})
