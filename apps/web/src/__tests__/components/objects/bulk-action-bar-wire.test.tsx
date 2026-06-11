import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { useBulkDeleteObjects, useBulkUpdateObjects } from '@/hooks/use-objects'
import type { BulkUpdateObjectsResponse, ObjectResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			bulkUpdate: vi.fn(),
			delete: vi.fn(),
			bulkDelete: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/api'

const workspaceId = 'ws-1'

function buildObject(o: Partial<ObjectResponse> & { id: string }): ObjectResponse {
	return {
		workspaceId,
		type: 'task',
		title: o.title ?? null,
		content: null,
		status: 'todo',
		metadata: null,
		owner: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...o,
	}
}

interface HarnessProps {
	selectedIds: string[]
	onClear: () => void
}

function Harness({ selectedIds, onClear }: HarnessProps) {
	const bulkUpdate = useBulkUpdateObjects(workspaceId)

	const handleStatus = useCallback(
		(status: string) => {
			const ids = [...selectedIds]
			bulkUpdate.mutate(
				{ ids, patch: { status } },
				{
					onSuccess: (data: BulkUpdateObjectsResponse) => {
						const okCount = data.results.filter((r) => r.ok).length
						const failed = ids.length - okCount
						if (failed === 0) {
							toast.success(`${okCount} object${okCount === 1 ? '' : 's'} updated`)
							onClear()
						} else {
							toast.error(`${okCount} of ${ids.length} updated; ${failed} failed`)
						}
					},
				},
			)
		},
		[selectedIds, bulkUpdate, onClear],
	)

	return (
		<BulkActionBar
			selectedCount={selectedIds.length}
			statusOptions={[
				{ value: 'todo', label: 'Todo' },
				{ value: 'done', label: 'Done' },
			]}
			ownerOptions={[]}
			onStatusChange={handleStatus}
			onClear={onClear}
		/>
	)
}

function renderWithClient(ui: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 1000 * 60 },
			mutations: { retry: false },
		},
	})
	const utils = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
	return { ...utils, queryClient }
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('BulkActionBar wired to bulk-update', () => {
	it('mutates the cache, fires a success toast, and clears selection on full success', async () => {
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: true },
			],
		})
		const onClear = vi.fn()
		const { queryClient } = renderWithClient(
			<Harness selectedIds={['obj-1', 'obj-2']} onClear={onClear} />,
		)
		const key = queryKeys.objects.listInfinite(workspaceId, {})
		queryClient.setQueryData(key, {
			pages: [
				[
					buildObject({ id: 'obj-1', status: 'todo' }),
					buildObject({ id: 'obj-2', status: 'todo' }),
					buildObject({ id: 'obj-3', status: 'todo' }),
				],
			],
			pageParams: [0],
		})

		fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
		fireEvent.click(screen.getByRole('option', { name: 'Done' }))

		await waitFor(() =>
			expect(api.objects.bulkUpdate).toHaveBeenCalledWith(workspaceId, {
				ids: ['obj-1', 'obj-2'],
				patch: { status: 'done' },
			}),
		)
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 objects updated'))
		await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))

		const cache = queryClient.getQueryData<{ pages: ObjectResponse[][] }>(key)
		const rows = cache?.pages[0] ?? []
		expect(rows.find((r) => r.id === 'obj-1')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-2')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-3')?.status).toBe('todo')
	})

	it('reports partial failure and does NOT clear selection when some rows fail', async () => {
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: false, error: "Invalid status 'done' for type 'bet'" },
			],
		})
		const onClear = vi.fn()
		renderWithClient(<Harness selectedIds={['obj-1', 'obj-2']} onClear={onClear} />)

		fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
		fireEvent.click(screen.getByRole('option', { name: 'Done' }))

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 of 2 updated; 1 failed'))
		expect(onClear).not.toHaveBeenCalled()
	})
})

// Harness wiring BulkActionBar's built-in confirm gate to useBulkDeleteObjects.
// BulkActionBar manages its own confirm Dialog; onDelete fires post-confirmation.
function DeleteHarness({
	selectedIds,
	onClear,
}: {
	selectedIds: string[]
	onClear: () => void
}) {
	const bulkDelete = useBulkDeleteObjects(workspaceId)

	const handleDelete = useCallback(() => {
		// Called by BulkActionBar after the user confirms — no extra gate needed here.
		bulkDelete.mutate(
			{ ids: [...selectedIds] },
			{
				onSuccess: (data) => {
					const ok = data.results.filter((r) => r.ok).length
					toast.success(`${ok} deleted`)
					if (ok === selectedIds.length) onClear()
				},
				onError: () => toast.error('Delete failed'),
			},
		)
	}, [selectedIds, bulkDelete, onClear])

	return (
		<BulkActionBar
			selectedCount={selectedIds.length}
			statusOptions={[]}
			ownerOptions={[]}
			onDelete={handleDelete}
			onClear={onClear}
		/>
	)
}

describe('Bulk delete — BulkActionBar confirm gate + useBulkDeleteObjects', () => {
	it('shows built-in confirm dialog on delete click without calling the API', async () => {
		vi.mocked(api.objects.bulkDelete).mockResolvedValue({ results: [] })
		const onClear = vi.fn()
		renderWithClient(<DeleteHarness selectedIds={['obj-1']} onClear={onClear} />)

		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

		// BulkActionBar's built-in confirm dialog should be visible
		expect(screen.getByText('Delete 1 selected?')).toBeInTheDocument()
		expect(api.objects.bulkDelete).not.toHaveBeenCalled()
	})

	it('executes delete and fires success toast after the built-in confirmation', async () => {
		vi.mocked(api.objects.bulkDelete).mockResolvedValue({
			results: [{ id: 'obj-1', ok: true }],
		})
		const onClear = vi.fn()
		renderWithClient(<DeleteHarness selectedIds={['obj-1']} onClear={onClear} />)

		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
		// Click the destructive Delete button inside the confirm dialog
		const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
		const confirmBtn = deleteButtons[deleteButtons.length - 1]
		fireEvent.click(confirmBtn!)

		await waitFor(() =>
			expect(api.objects.bulkDelete).toHaveBeenCalledWith(workspaceId, { ids: ['obj-1'] }),
		)
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 deleted'))
		await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))
	})

	it('cancels the confirm dialog without calling the API', async () => {
		vi.mocked(api.objects.bulkDelete).mockResolvedValue({ results: [] })
		const onClear = vi.fn()
		renderWithClient(<DeleteHarness selectedIds={['obj-1']} onClear={onClear} />)

		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

		await waitFor(() => expect(screen.queryByText('Delete 1 selected?')).not.toBeInTheDocument())
		expect(api.objects.bulkDelete).not.toHaveBeenCalled()
	})
})
