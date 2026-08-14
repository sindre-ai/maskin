import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		loops: {
			list: vi.fn(),
			activity: vi.fn(),
		},
	},
}))

import { useLoop, useLoopActivity, useLoops } from '@/hooks/use-loops'
import { type EventResponse, type LoopSummary, api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId,
		name: 'Customer feedback',
		guarantee: 'Every customer who gives feedback hears back within 30 days',
		status: 'running',
		pill: 'running',
		entryCondition: null,
		closeCondition: null,
		humanDecisionPoints: null,
		inProgressCount: 3,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
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
