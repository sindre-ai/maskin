import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		triggers: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import {
	useCreateTrigger,
	useDeleteTrigger,
	useTrigger,
	useTriggers,
	useUpdateTrigger,
} from '@/hooks/use-triggers'
import type { TriggerResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

function buildTrigger(overrides: Partial<TriggerResponse> & { id: string }): TriggerResponse {
	return {
		workspaceId: 'ws-1',
		name: 'Test Trigger',
		type: 'cron',
		config: null,
		actionPrompt: 'Run task',
		targetActorId: 'actor-1',
		enabled: true,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useTriggers', () => {
	it('fetches triggers for workspace', async () => {
		const mockTriggers = [
			buildTrigger({ id: 'trigger-1', name: 'Daily sync' }),
			buildTrigger({ id: 'trigger-2', name: 'On event', type: 'event' }),
		]
		vi.mocked(api.triggers.list).mockResolvedValue(mockTriggers)

		const { result } = renderHook(() => useTriggers(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockTriggers)
		expect(api.triggers.list).toHaveBeenCalledWith(workspaceId)
	})

	it('exposes error when API rejects', async () => {
		vi.mocked(api.triggers.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useTriggers(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error?.message).toBe('Network error')
	})
})

describe('useTrigger', () => {
	it('returns matching trigger from list', async () => {
		const mockTriggers = [
			buildTrigger({ id: 'trigger-1', name: 'Daily sync' }),
			buildTrigger({ id: 'trigger-2', name: 'On event' }),
		]
		vi.mocked(api.triggers.list).mockResolvedValue(mockTriggers)

		const { result } = renderHook(() => useTrigger('trigger-2', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.id).toBe('trigger-2')
		expect(result.current.data?.name).toBe('On event')
	})

	it('returns undefined when trigger not found', async () => {
		vi.mocked(api.triggers.list).mockResolvedValue([])

		const { result } = renderHook(() => useTrigger('nonexistent', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeUndefined()
	})
})

describe('useCreateTrigger', () => {
	it('calls api.triggers.create with workspace and data', async () => {
		const newTrigger = buildTrigger({ id: 'trigger-new', name: 'New Trigger' })
		vi.mocked(api.triggers.create).mockResolvedValue(newTrigger)

		const { result } = renderHook(() => useCreateTrigger(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({
			name: 'New Trigger',
			type: 'cron',
			config: { expression: '0 * * * *' },
			action_prompt: 'Run it',
			target_actor_id: 'actor-1',
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.triggers.create).toHaveBeenCalledWith(workspaceId, {
			name: 'New Trigger',
			type: 'cron',
			config: { expression: '0 * * * *' },
			action_prompt: 'Run it',
			target_actor_id: 'actor-1',
		})
	})

	it('exposes error when create fails', async () => {
		vi.mocked(api.triggers.create).mockRejectedValue(new Error('Validation failed'))

		const { result } = renderHook(() => useCreateTrigger(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({
			name: 'Bad',
			type: 'cron',
			config: { expression: '' },
			action_prompt: 'Nope',
			target_actor_id: 'actor-1',
		})
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Validation failed')
	})
})

describe('useUpdateTrigger', () => {
	it('calls api.triggers.update with id, workspace, and data', async () => {
		const updated = buildTrigger({ id: 'trigger-1', name: 'Updated' })
		vi.mocked(api.triggers.update).mockResolvedValue(updated)

		const { result } = renderHook(() => useUpdateTrigger(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'trigger-1', data: { name: 'Updated' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.triggers.update).toHaveBeenCalledWith('trigger-1', workspaceId, {
			name: 'Updated',
		})
	})

	it('exposes error when update fails', async () => {
		vi.mocked(api.triggers.update).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useUpdateTrigger(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'trigger-1', data: { name: 'Nope' } })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Not found')
	})
})

describe('useDeleteTrigger', () => {
	it('calls api.triggers.delete with id and workspace', async () => {
		vi.mocked(api.triggers.delete).mockResolvedValue({ deleted: true })

		const { result } = renderHook(() => useDeleteTrigger(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('trigger-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.triggers.delete).toHaveBeenCalledWith('trigger-1', workspaceId)
	})

	it('exposes error when delete fails', async () => {
		vi.mocked(api.triggers.delete).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useDeleteTrigger(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('trigger-1')
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Forbidden')
	})
})
