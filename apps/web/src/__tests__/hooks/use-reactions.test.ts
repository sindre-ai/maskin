import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		reactions: {
			listByObject: vi.fn(),
			add: vi.fn(),
			remove: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: vi.fn(),
}))

import { useReactionsByObject, useToggleReaction } from '@/hooks/use-reactions'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const objectId = 'obj-1'
const me = { id: 'actor-me', type: 'human', name: 'Me' } as ReturnType<typeof getStoredActor>

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(getStoredActor).mockReturnValue(me)
})

describe('useReactionsByObject', () => {
	it('fetches reactions and returns them grouped by event id', async () => {
		vi.mocked(api.reactions.listByObject).mockResolvedValue({
			reactionsByEventId: {
				'42': [
					{
						id: 'r1',
						eventId: 42,
						actorId: 'actor-other',
						emoji: '👍',
						createdAt: '2026-01-01T00:00:00.000Z',
					},
				],
			},
		})

		const { result } = renderHook(() => useReactionsByObject(workspaceId, objectId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.reactions.listByObject).toHaveBeenCalledWith(workspaceId, objectId, {
			eventIds: undefined,
		})
		expect(result.current.data?.reactionsByEventId['42']).toHaveLength(1)
	})

	it('is disabled when enabled=false', () => {
		renderHook(() => useReactionsByObject(workspaceId, objectId, { enabled: false }), {
			wrapper: TestWrapper,
		})
		expect(api.reactions.listByObject).not.toHaveBeenCalled()
	})

	it('passes eventIds through to the API and scopes the cache key', async () => {
		vi.mocked(api.reactions.listByObject).mockResolvedValue({ reactionsByEventId: {} })

		const { result } = renderHook(
			() => useReactionsByObject(workspaceId, objectId, { eventIds: [11, 10, 12] }),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.reactions.listByObject).toHaveBeenCalledWith(workspaceId, objectId, {
			eventIds: [11, 10, 12],
		})
	})
})

describe('useToggleReaction', () => {
	it('calls api.reactions.add when op=add', async () => {
		vi.mocked(api.reactions.add).mockResolvedValue({ added: true })
		const { result } = renderHook(() => useToggleReaction(workspaceId, objectId), {
			wrapper: TestWrapper,
		})

		await result.current.mutateAsync({ eventId: 99, emoji: '👍', op: 'add' })
		expect(api.reactions.add).toHaveBeenCalledWith(workspaceId, 99, '👍')
		expect(api.reactions.remove).not.toHaveBeenCalled()
	})

	it('calls api.reactions.remove when op=remove', async () => {
		vi.mocked(api.reactions.remove).mockResolvedValue({ removed: true })
		const { result } = renderHook(() => useToggleReaction(workspaceId, objectId), {
			wrapper: TestWrapper,
		})

		await result.current.mutateAsync({ eventId: 99, emoji: '🎉', op: 'remove' })
		expect(api.reactions.remove).toHaveBeenCalledWith(workspaceId, 99, '🎉')
		expect(api.reactions.add).not.toHaveBeenCalled()
	})
})
