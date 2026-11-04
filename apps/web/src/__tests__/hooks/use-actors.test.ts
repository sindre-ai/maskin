import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { type ReactNode, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		actors: {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			reset: vi.fn(),
			pause: vi.fn(),
			run: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
	},
}))

import {
	useActor,
	useActors,
	useAgent,
	useAgentPause,
	useAgentRun,
	useCreateActor,
	useDeleteActor,
	useResetActor,
	useUpdateActor,
} from '@/hooks/use-actors'
import type { ActorListItem, ActorResponse, ActorWithKey } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildActorListItem(overrides: Partial<ActorListItem> & { id: string }): ActorListItem {
	return {
		type: 'human',
		name: 'Test Actor',
		email: null,
		description: null,
		isSystem: false,
		agentState: 'idle',
		...overrides,
	}
}

function buildActorResponse(overrides: Partial<ActorResponse> & { id: string }): ActorResponse {
	return {
		type: 'human',
		name: 'Test Actor',
		email: null,
		description: null,
		system_prompt: null,
		tools: null,
		memory: null,
		llm_provider: null,
		llm_config: null,
		isSystem: false,
		agentState: 'idle',
		agentStateUpdatedAt: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useActors', () => {
	it('fetches actors for workspace', async () => {
		const mockActors = [
			buildActorListItem({ id: 'actor-1', name: 'Alice' }),
			buildActorListItem({ id: 'actor-2', name: 'Bob', type: 'agent' }),
		]
		vi.mocked(api.actors.list).mockResolvedValue(mockActors)

		const { result } = renderHook(() => useActors(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockActors)
		expect(api.actors.list).toHaveBeenCalledWith(workspaceId)
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.actors.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useActors(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error?.message).toBe('Network error')
	})
})

describe('useActor', () => {
	it('fetches actor by id', async () => {
		const mockActor = buildActorResponse({ id: 'actor-1', name: 'Alice' })
		vi.mocked(api.actors.get).mockResolvedValue(mockActor)

		const { result } = renderHook(() => useActor('actor-1'), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockActor)
		expect(api.actors.get).toHaveBeenCalledWith('actor-1')
	})

	it('is not enabled when id is empty', async () => {
		const { result } = renderHook(() => useActor(''), { wrapper: TestWrapper })

		expect(result.current.isFetching).toBe(false)
		expect(api.actors.get).not.toHaveBeenCalled()
	})
})

describe('useAgent', () => {
	it('returns matching actor from list', async () => {
		const mockActors = [
			buildActorListItem({ id: 'actor-1', name: 'Alice' }),
			buildActorListItem({ id: 'actor-2', name: 'Agent Bob', type: 'agent' }),
		]
		vi.mocked(api.actors.list).mockResolvedValue(mockActors)

		const { result } = renderHook(() => useAgent('actor-2', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.id).toBe('actor-2')
		expect(result.current.data?.name).toBe('Agent Bob')
	})

	it('returns undefined when not found', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([])

		const { result } = renderHook(() => useAgent('nonexistent', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeUndefined()
	})
})

describe('useCreateActor', () => {
	it('calls api.actors.create with data', async () => {
		const newActor: ActorWithKey = {
			...buildActorResponse({ id: 'actor-new', name: 'New Agent', type: 'agent' }),
			api_key: 'ank_test123',
		}
		vi.mocked(api.actors.create).mockResolvedValue(newActor)

		const { result } = renderHook(() => useCreateActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ type: 'agent', name: 'New Agent' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.actors.create).toHaveBeenCalledWith({ type: 'agent', name: 'New Agent' })
	})

	it('exposes error when create fails', async () => {
		vi.mocked(api.actors.create).mockRejectedValue(new Error('Validation failed'))

		const { result } = renderHook(() => useCreateActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ type: 'agent', name: 'Bad' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Validation failed')
	})
})

describe('useUpdateActor', () => {
	it('calls api.actors.update with id and data', async () => {
		const updated = buildActorResponse({ id: 'actor-1', name: 'Updated' })
		vi.mocked(api.actors.update).mockResolvedValue(updated)

		const { result } = renderHook(() => useUpdateActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'actor-1', data: { name: 'Updated' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.actors.update).toHaveBeenCalledWith('actor-1', { name: 'Updated' }, workspaceId)
	})

	it('exposes error when update fails', async () => {
		vi.mocked(api.actors.update).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useUpdateActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'actor-1', data: { name: 'Nope' } })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Not found')
	})
})

describe('useDeleteActor', () => {
	const keep = buildActorListItem({ id: 'keep', name: 'Keeper' })
	const doomed = buildActorListItem({ id: 'doomed', name: 'Planner' })

	function setup() {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		queryClient.setQueryData(queryKeys.actors.all(workspaceId), [keep, doomed])
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, children)
		const hook = renderHook(() => useDeleteActor(workspaceId), { wrapper })
		return { queryClient, hook }
	}

	it('shows a loading toast, drops the agent from the list, then swaps in a success toast', async () => {
		let finish: (v: { deleted: boolean }) => void = () => {}
		vi.mocked(api.actors.delete).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		vi.mocked(api.actors.list).mockResolvedValue([keep])
		const { queryClient, hook } = setup()

		hook.result.current.mutate({ id: 'doomed', name: 'Planner' })

		await waitFor(() =>
			expect(toast.loading).toHaveBeenCalledWith('Deleting Planner...', {
				id: 'delete-actor-doomed',
			}),
		)
		await waitFor(() =>
			expect(queryClient.getQueryData(queryKeys.actors.all(workspaceId))).toEqual([keep]),
		)
		expect(toast.success).not.toHaveBeenCalled()

		finish({ deleted: true })
		await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
		expect(api.actors.delete).toHaveBeenCalledWith('doomed', workspaceId)
		expect(toast.success).toHaveBeenCalledWith('Deleted Planner', { id: 'delete-actor-doomed' })
	})

	it('says the agent was not deleted and brings it back when the delete fails', async () => {
		vi.mocked(api.actors.delete).mockRejectedValue(new Error('Server error'))
		vi.mocked(api.actors.list).mockResolvedValue([keep, doomed])
		const { queryClient, hook } = setup()

		hook.result.current.mutate({ id: 'doomed', name: 'Planner' })

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Planner was not deleted', {
				id: 'delete-actor-doomed',
			}),
		)
		expect(queryClient.getQueryData(queryKeys.actors.all(workspaceId))).toEqual([keep, doomed])
		expect(toast.success).not.toHaveBeenCalled()
	})

	it('restores the previous list when the error refetch also fails', async () => {
		vi.mocked(api.actors.delete).mockRejectedValue(new Error('Offline'))
		vi.mocked(api.actors.list).mockRejectedValue(new Error('Offline'))
		const { queryClient, hook } = setup()

		hook.result.current.mutate({ id: 'doomed', name: 'Planner' })

		await waitFor(() => expect(toast.error).toHaveBeenCalled())
		expect(queryClient.getQueryData(queryKeys.actors.all(workspaceId))).toEqual([keep, doomed])
	})

	it('reports success when the request errors but the server finished the delete', async () => {
		vi.mocked(api.actors.delete).mockRejectedValue(new Error('504 Gateway Timeout'))
		vi.mocked(api.actors.list).mockResolvedValue([keep])
		const { hook } = setup()

		hook.result.current.mutate({ id: 'doomed', name: 'Planner' })

		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Deleted Planner', { id: 'delete-actor-doomed' }),
		)
		expect(toast.error).not.toHaveBeenCalled()
	})
})

describe('useResetActor', () => {
	it('calls api.actors.reset with id and workspaceId and toasts success', async () => {
		const reset = buildActorResponse({ id: 'actor-1', name: 'Workspace Coach', isSystem: true })
		vi.mocked(api.actors.reset).mockResolvedValue(reset)

		const { result } = renderHook(() => useResetActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('actor-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.actors.reset).toHaveBeenCalledWith('actor-1', workspaceId)
		expect(toast.success).toHaveBeenCalledWith('Agent reset to default')
	})

	it('toasts error when reset fails', async () => {
		vi.mocked(api.actors.reset).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useResetActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('actor-1')
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(toast.error).toHaveBeenCalledWith('Failed to reset agent')
	})
})

describe('useAgentPause', () => {
	it('calls api.actors.pause with id and workspaceId', async () => {
		const paused = buildActorResponse({ id: 'agent-1', agentState: 'paused' })
		vi.mocked(api.actors.pause).mockResolvedValue(paused)

		const { result } = renderHook(() => useAgentPause(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('agent-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.actors.pause).toHaveBeenCalledWith('agent-1', workspaceId)
	})

	it('exposes error state when pause fails', async () => {
		vi.mocked(api.actors.pause).mockRejectedValue(new Error('Failed'))

		const { result } = renderHook(() => useAgentPause(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('agent-1')
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(toast.error).not.toHaveBeenCalled()
	})
})

describe('useAgentRun', () => {
	it('calls api.actors.run with id, workspaceId, and body', async () => {
		const running = buildActorResponse({ id: 'agent-1', agentState: 'running' })
		vi.mocked(api.actors.run).mockResolvedValue(running)

		const { result } = renderHook(() => useAgentRun(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'agent-1', body: { action_prompt: 'go' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.actors.run).toHaveBeenCalledWith('agent-1', workspaceId, { action_prompt: 'go' })
	})

	it('passes undefined body when not provided', async () => {
		const running = buildActorResponse({ id: 'agent-1', agentState: 'running' })
		vi.mocked(api.actors.run).mockResolvedValue(running)

		const { result } = renderHook(() => useAgentRun(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'agent-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.actors.run).toHaveBeenCalledWith('agent-1', workspaceId, undefined)
	})

	it('exposes error state when run fails', async () => {
		vi.mocked(api.actors.run).mockRejectedValue(new Error('Boom'))

		const { result } = renderHook(() => useAgentRun(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'agent-1' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(toast.error).not.toHaveBeenCalled()
	})
})
