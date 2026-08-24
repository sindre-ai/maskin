import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const objectsRef = vi.hoisted(() => ({ current: { data: undefined as unknown } }))
const loopsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const actorsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const triggersRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const conversationsRef = vi.hoisted(() => ({ current: { data: undefined as unknown } }))
const searchObjectsSpy = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-objects', () => ({
	useSearchObjects: (workspaceId: string, params: unknown) => {
		searchObjectsSpy(workspaceId, params)
		return objectsRef.current
	},
}))
vi.mock('@/hooks/use-loops', () => ({ useLoops: () => loopsRef.current }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => actorsRef.current }))
vi.mock('@/hooks/use-triggers', () => ({ useTriggers: () => triggersRef.current }))
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => conversationsRef.current,
}))

import { useWorkspaceSearch } from '@/hooks/use-workspace-search'

beforeEach(() => {
	objectsRef.current = { data: [] }
	loopsRef.current = { data: [] }
	actorsRef.current = { data: [] }
	triggersRef.current = { data: [] }
	conversationsRef.current = { data: undefined }
	searchObjectsSpy.mockClear()
})

function seedAll() {
	conversationsRef.current = {
		data: {
			pages: [
				{
					conversations: [
						{ id: 'c-1', title: 'Relay handoff', snippet: null, participants: [] },
						{ id: 'c-2', title: 'Unrelated', snippet: null, participants: [] },
					],
				},
			],
		},
	}
	loopsRef.current = {
		data: [
			{ id: 'l-1', name: 'Relay loop', guarantee: null, entryCondition: null, status: 'running' },
		],
	}
	actorsRef.current = {
		data: [
			{ id: 'a-1', type: 'agent', name: 'Relay', description: null },
			{ id: 'h-1', type: 'human', name: 'Relay Person', description: null },
		],
	}
	triggersRef.current = {
		data: [{ id: 't-1', name: 'Relay sweep', type: 'cron', actionPrompt: 'sweep' }],
	}
	objectsRef.current = {
		data: [{ id: 'o-1', type: 'bet', title: 'Relay bet', content: null, status: 'active' }],
	}
}

describe('useWorkspaceSearch', () => {
	it('buckets every entity into its own group with per-group counts', () => {
		seedAll()
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'relay' }))

		expect(result.current.countsByGroup).toEqual({
			chats: 1,
			loops: 1,
			// The human actor never enters the agents group.
			agents: 1,
			objects: 1,
			automations: 1,
		})
		expect(result.current.total).toBe(5)
	})

	it('leaves a group with no hits at zero so its chip never renders', () => {
		seedAll()
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'sweep' }))

		expect(result.current.countsByGroup.chats).toBe(0)
		expect(result.current.countsByGroup.automations).toBe(1)
	})

	it('passes the query to the server for objects and filters the rest client-side', () => {
		seedAll()
		// The object row survives even though its title does not contain the
		// needle — the server already decided that set.
		objectsRef.current = {
			data: [{ id: 'o-1', type: 'bet', title: 'Nothing alike', content: null, status: 'active' }],
		}
		const { result } = renderHook(() =>
			useWorkspaceSearch('ws-1', { q: 'relay', type: 'bet', status: 'active' }),
		)

		expect(searchObjectsSpy).toHaveBeenCalledWith('ws-1', {
			q: 'relay',
			type: 'bet',
			status: 'active',
		})
		expect(result.current.countsByGroup.objects).toBe(1)
	})

	it('matches case-insensitively on the subtitle as well as the title', () => {
		conversationsRef.current = {
			data: {
				pages: [
					{
						conversations: [
							{
								id: 'c-1',
								title: 'Standup',
								snippet: null,
								participants: [{ actorName: 'Compass' }],
							},
						],
					},
				],
			},
		}
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'COMPASS' }))

		expect(result.current.countsByGroup.chats).toBe(1)
		expect(result.current.rows[0]?.sub).toBe('Compass')
	})

	it('returns an empty index and no pending state for a blank query', () => {
		seedAll()
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: '   ' }))

		expect(result.current.total).toBe(0)
		expect(result.current.isPending).toBe(false)
	})

	it('reports pending while the object search has not resolved', () => {
		objectsRef.current = { data: undefined }
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'relay' }))

		expect(result.current.isPending).toBe(true)
	})
})
