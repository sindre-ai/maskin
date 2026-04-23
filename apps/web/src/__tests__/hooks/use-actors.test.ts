import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		actors: {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			reset: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}))

import {
	useActor,
	useActors,
	useAgent,
	useCreateActor,
	useResetActor,
	useUpdateActor,
} from '@/hooks/use-actors'
import type { ActorListItem, ActorResponse, ActorWithKey } from '@/lib/api'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildActorListItem(overrides: Partial<ActorListItem> & { id: string }): ActorListItem {
	return {
		type: 'human',
		name: 'Test Actor',
		email: null,
		...overrides,
	}
}

function buildActorResponse(overrides: Partial<ActorResponse> & { id: string }): ActorResponse {
	return {
		type: 'human',
		name: 'Test Actor',
		email: null,
		systemPrompt: null,
		tools: null,
		memory: null,
		llmProvider: null,
		llmConfig: null,
		isSystem: false,
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
		expect(api.actors.update).toHaveBeenCalledWith('actor-1', { name: 'Updated' })
	})

	it('exposes error when update fails', async () => {
		vi.mocked(api.actors.update).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useUpdateActor(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'actor-1', data: { name: 'Nope' } })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Not found')
	})
})

describe('useResetActor', () => {
	it('calls api.actors.reset with id and workspaceId and toasts success', async () => {
		const reset = buildActorResponse({ id: 'actor-1', name: 'Sindre', isSystem: true })
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
