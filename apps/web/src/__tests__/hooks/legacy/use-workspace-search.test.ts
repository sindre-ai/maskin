import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const objectsRef = vi.hoisted(() => ({ current: { data: undefined as unknown } }))
const loopsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const actorsRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const triggersRef = vi.hoisted(() => ({ current: { data: [] as unknown[] } }))
const conversationsRef = vi.hoisted(() => ({ current: { data: undefined as unknown } }))
const searchObjectsSpy = vi.hoisted(() => vi.fn())
const listOptionsSpy = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-objects', () => ({
	useSearchObjects: (workspaceId: string, params: unknown, options?: unknown) => {
		searchObjectsSpy(workspaceId, params, options)
		return objectsRef.current
	},
}))
vi.mock('@/hooks/use-loops', () => ({
	useLoops: (_ws: string, options?: unknown) => {
		listOptionsSpy('loops', options)
		return loopsRef.current
	},
}))
vi.mock('@/hooks/use-actors', () => ({
	useActors: (_ws: string, options?: unknown) => {
		listOptionsSpy('actors', options)
		return actorsRef.current
	},
}))
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: (_ws: string, options?: unknown) => {
		listOptionsSpy('triggers', options)
		return triggersRef.current
	},
}))
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: (_ws: string, _filters?: unknown, options?: unknown) => {
		listOptionsSpy('chats', options)
		return conversationsRef.current
	},
}))

import { matches, useWorkspaceSearch } from '@/hooks/legacy/use-workspace-search'

beforeEach(() => {
	objectsRef.current = { data: [] }
	loopsRef.current = { data: [] }
	actorsRef.current = { data: [] }
	triggersRef.current = { data: [] }
	conversationsRef.current = { data: undefined }
	searchObjectsSpy.mockClear()
	listOptionsSpy.mockClear()
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
	it('turns every request off while the surface is closed', () => {
		seedAll()
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'relay', enabled: false }))

		expect(searchObjectsSpy).toHaveBeenCalledWith(
			'ws-1',
			expect.anything(),
			expect.objectContaining({ enabled: false }),
		)
		for (const list of ['loops', 'actors', 'triggers', 'chats']) {
			expect(listOptionsSpy).toHaveBeenCalledWith(list, { enabled: false })
		}
		expect(result.current.rows).toEqual([])
		expect(result.current.isSettled).toBe(false)
	})

	it('filters local lists by q while the object search runs on serverQ, unsettled until they meet', () => {
		seedAll()
		const { result, rerender } = renderHook(
			({ serverQ }) => useWorkspaceSearch('ws-1', { q: 'relay', serverQ }),
			{ initialProps: { serverQ: 'rel' } },
		)

		expect(searchObjectsSpy).toHaveBeenLastCalledWith(
			'ws-1',
			{ q: 'rel', type: undefined, status: undefined },
			expect.objectContaining({ keepPrevious: true }),
		)
		// Chats, loops, agents, people and automations already answer to "relay".
		expect(result.current.countsByGroup.loops).toBe(1)
		expect(result.current.isSettled).toBe(false)

		rerender({ serverQ: 'relay' })
		expect(result.current.isSettled).toBe(true)
	})

	it('buckets every entity into its own group with per-group counts', () => {
		seedAll()
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'relay' }))

		expect(result.current.countsByGroup).toEqual({
			chats: 1,
			loops: 1,
			// The human actor lands in people, never in agents.
			agents: 1,
			people: 1,
			objects: 1,
			automations: 1,
		})
		expect(result.current.total).toBe(6)
	})

	it('finds a person by name and opens their dialog on the members page', () => {
		seedAll()
		actorsRef.current = {
			data: [
				{ id: 'a-1', type: 'agent', name: 'Sales Rep (Magnus)', description: null },
				{ id: 'h-1', type: 'human', name: 'Magnus', description: null },
			],
		}
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'magnus' }))

		// The exact-name person outranks the agent that merely mentions him.
		const [first] = result.current.rows
		expect(first).toMatchObject({
			id: 'h-1',
			group: 'people',
			kind: 'PERSON',
			to: '/$workspaceId/settings/members',
			search: { member: 'h-1' },
		})
	})

	it('finds a person despite a typo, below an exact hit', () => {
		seedAll()
		actorsRef.current = {
			data: [
				{ id: 'h-1', type: 'human', name: 'Magnus', description: null },
				{ id: 'a-1', type: 'agent', name: 'Mgnus bot', description: null },
			],
		}
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'mgnus' }))

		// seedAll's object is returned by the (mocked) server search whatever the query,
		// so only compare the actors.
		const actors = result.current.rows.filter((r) => r.group !== 'objects')
		expect(actors.map((r) => r.id)).toEqual(['a-1', 'h-1'])
		expect(result.current.countsByGroup.people).toBe(1)
	})

	it('finds a person when the words are typed in the other order', () => {
		seedAll()
		actorsRef.current = {
			data: [{ id: 'h-1', type: 'human', name: 'Anna Baker', description: null }],
		}
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'baker anna' }))

		expect(result.current.countsByGroup.people).toBe(1)
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

		expect(searchObjectsSpy).toHaveBeenCalledWith(
			'ws-1',
			{ q: 'relay', type: 'bet', status: 'active' },
			expect.objectContaining({ enabled: true }),
		)
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

	it('lists title matches before content-only matches, across groups', () => {
		conversationsRef.current = {
			data: {
				pages: [
					{
						conversations: [
							{ id: 'c-1', title: 'Standup', snippet: 'about the relay', participants: [] },
						],
					},
				],
			},
		}
		objectsRef.current = {
			data: [
				{ id: 'o-1', type: 'bet', title: 'Other', content: 'relay in body', status: 'active' },
				{ id: 'o-2', type: 'bet', title: 'Relay bet', content: null, status: 'active' },
			],
		}
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'relay' }))

		expect(result.current.rows.map((r) => r.id)).toEqual(['o-2', 'c-1', 'o-1'])
	})

	it('reports pending while the object search has not resolved', () => {
		objectsRef.current = { data: undefined }
		const { result } = renderHook(() => useWorkspaceSearch('ws-1', { q: 'relay' }))

		expect(result.current.isPending).toBe(true)
	})
})

describe('matches', () => {
	it('accepts a near miss of a word, but not for short terms', () => {
		expect(matches('mgnus', 'Magnus')).toBe(true)
		expect(matches('magnsu', 'Magnus')).toBe(true)
		expect(matches('magn', 'Magnus')).toBe(true)
		// Three letters: one wrong letter is a different word.
		expect(matches('cat', 'cut')).toBe(false)
	})

	it('needs every term, across fields and in any order', () => {
		expect(matches('baker anna', 'Anna Baker')).toBe(true)
		expect(matches('anna', 'Baker', 'Anna')).toBe(true)
		expect(matches('anna zebra', 'Anna Baker')).toBe(false)
	})

	it('rejects unrelated words that are far from the term', () => {
		expect(matches('magnus', 'Manager')).toBe(false)
		expect(matches('', 'anything')).toBe(true)
	})
})
