import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

// Suppress toast in tests
vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/api'
import { useCreateObject, useDeleteObject, useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useObjects', () => {
	it('exposes error when API rejects', async () => {
		vi.mocked(api.objects.list).mockRejectedValue(new Error('Network error'))

		const { result } = renderHook(() => useObjects(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error!.message).toBe('Network error')
	})

	it('fetches objects for workspace', async () => {
		const mockObjects = [
			{ id: 'obj-1', title: 'Task 1', type: 'task' },
			{ id: 'obj-2', title: 'Bet 1', type: 'bet' },
		]
		vi.mocked(api.objects.list).mockResolvedValue(mockObjects)

		const { result } = renderHook(() => useObjects(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockObjects)
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, undefined)
	})

	it('passes filters to API call', async () => {
		vi.mocked(api.objects.list).mockResolvedValue([])
		const filters = { type: 'task', status: 'todo' }

		const { result } = renderHook(() => useObjects(workspaceId, filters), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.list).toHaveBeenCalledWith(workspaceId, filters)
	})
})

describe('useObject', () => {
	it('returns matching object from list', async () => {
		const mockObjects = [
			{ id: 'obj-1', title: 'Task 1', type: 'task' },
			{ id: 'obj-2', title: 'Bet 1', type: 'bet' },
		]
		vi.mocked(api.objects.list).mockResolvedValue(mockObjects)

		const { result } = renderHook(() => useObject('obj-2', workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.id).toBe('obj-2')
	})

	it('returns undefined when object not found', async () => {
		vi.mocked(api.objects.list).mockResolvedValue([])

		const { result } = renderHook(() => useObject('nonexistent', workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeUndefined()
	})
})

describe('useCreateObject', () => {
	it('exposes error when create fails', async () => {
		vi.mocked(api.objects.create).mockRejectedValue(new Error('Validation failed'))

		const { result } = renderHook(() => useCreateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ type: 'task', title: 'Bad', status: 'todo' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error!.message).toBe('Validation failed')
	})

	it('calls api.objects.create with workspace and data', async () => {
		const newObject = { id: 'obj-new', title: 'New', type: 'task', status: 'todo' }
		vi.mocked(api.objects.create).mockResolvedValue(newObject)

		const { result } = renderHook(() => useCreateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ type: 'task', title: 'New', status: 'todo' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.create).toHaveBeenCalledWith(workspaceId, {
			type: 'task',
			title: 'New',
			status: 'todo',
		})
	})
})

describe('useUpdateObject', () => {
	it('exposes error when update fails', async () => {
		vi.mocked(api.objects.update).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useUpdateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'obj-1', data: { title: 'Nope' } })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error!.message).toBe('Not found')
	})

	it('calls api.objects.update with id and data', async () => {
		vi.mocked(api.objects.update).mockResolvedValue({ id: 'obj-1', title: 'Updated' })

		const { result } = renderHook(() => useUpdateObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ id: 'obj-1', data: { title: 'Updated' } })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.update).toHaveBeenCalledWith('obj-1', { title: 'Updated' })
	})
})

describe('useDeleteObject', () => {
	it('exposes error when delete fails', async () => {
		vi.mocked(api.objects.delete).mockRejectedValue(new Error('Forbidden'))

		const { result } = renderHook(() => useDeleteObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('obj-1')
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error!.message).toBe('Forbidden')
	})

	it('calls api.objects.delete with id', async () => {
		vi.mocked(api.objects.delete).mockResolvedValue(undefined)

		const { result } = renderHook(() => useDeleteObject(workspaceId), { wrapper: TestWrapper })

		result.current.mutate('obj-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.objects.delete).toHaveBeenCalledWith('obj-1')
	})
})
