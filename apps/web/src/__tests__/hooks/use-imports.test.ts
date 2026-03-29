import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		imports: {
			get: vi.fn(),
			create: vi.fn(),
			updateMapping: vi.fn(),
			confirm: vi.fn(),
		},
	},
}))

import {
	useConfirmImport,
	useCreateImport,
	useImport,
	useUpdateImportMapping,
} from '@/hooks/use-imports'
import { api } from '@/lib/api'
import { buildImportResponse } from '../factories'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('useImport', () => {
	it('is disabled when id is undefined', () => {
		const { result } = renderHook(() => useImport(undefined, workspaceId), {
			wrapper: TestWrapper,
		})

		expect(result.current.fetchStatus).toBe('idle')
		expect(api.imports.get).not.toHaveBeenCalled()
	})

	it('fetches import when id is provided', async () => {
		const mockImport = buildImportResponse({ id: 'imp-1' })
		vi.mocked(api.imports.get).mockResolvedValue(mockImport)

		const { result } = renderHook(() => useImport('imp-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockImport)
		expect(api.imports.get).toHaveBeenCalledWith('imp-1', workspaceId)
	})

	it('polls at 2000ms when status is importing', async () => {
		const importingResponse = buildImportResponse({ id: 'imp-1', status: 'importing' })
		vi.mocked(api.imports.get).mockResolvedValue(importingResponse)

		const { result } = renderHook(() => useImport('imp-1', workspaceId), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.imports.get).toHaveBeenCalledTimes(1)

		// Wait for the refetchInterval (2000ms) to trigger at least one more call
		await waitFor(() => {
			expect(vi.mocked(api.imports.get).mock.calls.length).toBeGreaterThan(1)
		}, { timeout: 5000 })
	})

	it('stops polling when status is not importing', async () => {
		const completedResponse = buildImportResponse({ id: 'imp-1', status: 'completed' })
		vi.mocked(api.imports.get).mockResolvedValue(completedResponse)

		const { result } = renderHook(() => useImport('imp-1', workspaceId), {
			wrapper: TestWrapper,
		})

		// Let initial fetch complete with real timers
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		const callCount = vi.mocked(api.imports.get).mock.calls.length

		// Switch to fake timers and advance well past polling interval
		vi.useFakeTimers()
		await vi.advanceTimersByTimeAsync(5000)

		// No additional calls should have been made
		expect(vi.mocked(api.imports.get).mock.calls.length).toBe(callCount)
	})
})

describe('useCreateImport', () => {
	it('calls api.imports.create with workspaceId and file', async () => {
		const mockImport = buildImportResponse({ id: 'imp-new' })
		vi.mocked(api.imports.create).mockResolvedValue(mockImport)

		const file = new File(['test content'], 'data.csv', { type: 'text/csv' })

		const { result } = renderHook(() => useCreateImport(workspaceId), {
			wrapper: TestWrapper,
		})

		result.current.mutate(file)
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.imports.create).toHaveBeenCalledWith(workspaceId, file)
	})
})

describe('useUpdateImportMapping', () => {
	it('calls api.imports.updateMapping', async () => {
		const mockImport = buildImportResponse({ id: 'imp-1' })
		vi.mocked(api.imports.updateMapping).mockResolvedValue(mockImport)

		const mapping = {
			objectType: 'task',
			columns: [
				{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
			],
		}

		const { result } = renderHook(() => useUpdateImportMapping(workspaceId), {
			wrapper: TestWrapper,
		})

		result.current.mutate({ id: 'imp-1', mapping })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.imports.updateMapping).toHaveBeenCalledWith('imp-1', mapping, workspaceId)
	})
})

describe('useConfirmImport', () => {
	it('calls api.imports.confirm', async () => {
		const mockImport = buildImportResponse({ id: 'imp-1', status: 'confirmed' })
		vi.mocked(api.imports.confirm).mockResolvedValue(mockImport)

		const { result } = renderHook(() => useConfirmImport(workspaceId), {
			wrapper: TestWrapper,
		})

		result.current.mutate('imp-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.imports.confirm).toHaveBeenCalledWith('imp-1', workspaceId)
	})
})
