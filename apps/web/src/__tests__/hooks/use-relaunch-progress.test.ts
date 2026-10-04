import { RESUMING_MAX_MS, useRelaunchProgress } from '@/hooks/use-relaunch-progress'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../setup'

const sessionsMock = vi.hoisted(() => ({
	data: [] as Array<{ id: string; actorId: string; status: string }>,
}))
const logsMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-sessions', () => ({
	useActiveSessionsForConversation: () => ({ data: sessionsMock.data }),
}))
vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return { ...actual, api: { ...actual.api, sessions: { ...actual.api.sessions, logs: logsMock } } }
})

const watch = {
	conversationId: 'conv-1',
	agentId: 'agent-1',
	knownSessionIds: new Set(['sess-old']),
}

beforeEach(() => {
	sessionsMock.data = [{ id: 'sess-old', actorId: 'agent-1', status: 'user_stopped' }]
	logsMock.mockReset().mockResolvedValue([])
	vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('useRelaunchProgress', () => {
	it('is null with nothing to watch', () => {
		const { result } = renderHook(() => useRelaunchProgress('ws-test', null), {
			wrapper: createWorkspaceWrapper(),
		})
		expect(result.current).toBeNull()
	})

	it('stays null while no new session exists, then clears itself after the cap so the row never sticks', () => {
		const { result } = renderHook(() => useRelaunchProgress('ws-test', watch), {
			wrapper: createWorkspaceWrapper(),
		})
		expect(result.current).toBeNull()
		act(() => {
			vi.advanceTimersByTime(RESUMING_MAX_MS - 1)
		})
		expect(result.current).toBeNull()
		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(result.current).toBe('timeout')
		expect(logsMock).not.toHaveBeenCalled()
	})

	it('ignores sessions that were already there, including other agents', () => {
		sessionsMock.data = [
			{ id: 'sess-old', actorId: 'agent-1', status: 'running' },
			{ id: 'sess-other', actorId: 'agent-2', status: 'failed' },
		]
		const { result } = renderHook(() => useRelaunchProgress('ws-test', watch), {
			wrapper: createWorkspaceWrapper(),
		})
		expect(result.current).toBeNull()
		expect(logsMock).not.toHaveBeenCalled()
	})

	it('reports ended when the new session ended without output', () => {
		sessionsMock.data = [
			{ id: 'sess-old', actorId: 'agent-1', status: 'user_stopped' },
			{ id: 'sess-new', actorId: 'agent-1', status: 'timeout' },
		]
		const { result } = renderHook(() => useRelaunchProgress('ws-test', watch), {
			wrapper: createWorkspaceWrapper(),
		})
		expect(result.current).toBe('ended')
		expect(logsMock).not.toHaveBeenCalled()
	})
})
