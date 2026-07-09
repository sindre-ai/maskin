import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { useBulkResultHandlers, useBulkUpdateObjects } from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RowSelectionState } from '@tanstack/react-table'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Integration test for the bulk-update round-trip. Mirrors the wiring on the
// objects route (`apps/web/src/routes/_authed/$workspaceId/objects/index.tsx`)
// so a regression in the selection-retention pattern or the wire contract
// surfaces here before it reaches Sebastian.

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			bulkUpdate: vi.fn(),
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
		title: o.title ?? o.id,
		content: null,
		status: 'todo',
		metadata: null,
		driver: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...o,
	}
}

// Harness owns row-selection state and calls into useBulkUpdateObjects the
// same way the objects route does — including the parity retain-only-failed
// step on partial success.
function Harness({
	initialSelection,
	statusOptions = [
		{ value: 'todo', label: 'Todo' },
		{ value: 'done', label: 'Done' },
	],
}: {
	initialSelection: string[]
	statusOptions?: Array<{ value: string; label: string }>
}) {
	const [rowSelection, setRowSelection] = useState<RowSelectionState>(() =>
		Object.fromEntries(initialSelection.map((id) => [id, true])),
	)
	const selectedIds = useMemo(() => Object.keys(rowSelection), [rowSelection])
	const clearSelection = useCallback(() => setRowSelection({}), [])

	const bulkUpdate = useBulkUpdateObjects(workspaceId)
	const { reportBulkResult, retainOnlyFailed } = useBulkResultHandlers(
		clearSelection,
		setRowSelection,
	)

	const handleStatus = useCallback(
		(status: string) => {
			const ids = [...selectedIds]
			bulkUpdate.mutate(
				{ ids, patch: { status } },
				{
					onSuccess: (data) => {
						retainOnlyFailed(data)
						reportBulkResult(data, ids.length, 'updated')
					},
					onError: () => toast.error('Failed to update objects'),
				},
			)
		},
		[selectedIds, bulkUpdate, reportBulkResult, retainOnlyFailed],
	)

	return (
		<>
			<div data-testid="selection-ids">{selectedIds.join(',')}</div>
			<BulkActionBar
				selectedCount={selectedIds.length}
				statusOptions={statusOptions}
				ownerOptions={[]}
				onStatusChange={handleStatus}
				onClear={clearSelection}
			/>
		</>
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

function pickStatus(label: string) {
	fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
	fireEvent.click(screen.getByRole('option', { name: label }))
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('bulk-update round-trip', () => {
	// AC-U4 / AC-T1: applying a status change fires one POST /bulk-update with
	// every selected id and clears selection on full success.
	it('AC-U4 full success — one POST with all ids, cache patched, selection cleared', async () => {
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: true },
				{ id: 'obj-3', ok: true },
			],
		})

		const { queryClient } = renderWithClient(
			<Harness initialSelection={['obj-1', 'obj-2', 'obj-3']} />,
		)
		const key = queryKeys.objects.listInfinite(workspaceId, {})
		queryClient.setQueryData(key, {
			pages: [
				[
					buildObject({ id: 'obj-1', status: 'todo' }),
					buildObject({ id: 'obj-2', status: 'todo' }),
					buildObject({ id: 'obj-3', status: 'todo' }),
					buildObject({ id: 'obj-4', status: 'todo' }),
				],
			],
			pageParams: [0],
		})

		pickStatus('Done')

		await waitFor(() =>
			expect(api.objects.bulkUpdate).toHaveBeenCalledWith(workspaceId, {
				ids: ['obj-1', 'obj-2', 'obj-3'],
				patch: { status: 'done' },
			}),
		)
		expect(api.objects.bulkUpdate).toHaveBeenCalledTimes(1)
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('3 objects updated'))
		await waitFor(() => expect(screen.getByTestId('selection-ids').textContent).toBe(''))

		const rows = queryClient.getQueryData<{ pages: ObjectResponse[][] }>(key)?.pages[0] ?? []
		expect(rows.find((r) => r.id === 'obj-1')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-2')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-3')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-4')?.status).toBe('todo')
	})

	// AC-T3: on non-2xx / network reject, rollbackBulkPatch restores every
	// snapshot and a user-visible error toast fires. Selection stays intact so
	// the operator can retry.
	it('AC-T3 500 reject — cache rolled back, error toast, selection preserved', async () => {
		vi.mocked(api.objects.bulkUpdate).mockRejectedValue(new Error('Internal Server Error'))

		const { queryClient } = renderWithClient(<Harness initialSelection={['obj-1', 'obj-2']} />)
		const key = queryKeys.objects.listInfinite(workspaceId, {})
		queryClient.setQueryData(key, {
			pages: [
				[
					buildObject({ id: 'obj-1', status: 'todo' }),
					buildObject({ id: 'obj-2', status: 'todo' }),
				],
			],
			pageParams: [0],
		})

		pickStatus('Done')

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update objects'))
		const rows = queryClient.getQueryData<{ pages: ObjectResponse[][] }>(key)?.pages[0] ?? []
		expect(rows.every((r) => r.status === 'todo')).toBe(true)
		expect(screen.getByTestId('selection-ids').textContent).toBe('obj-1,obj-2')
	})

	// AC-T4: mixed-result (3 ok / 2 not-ok) — succeeded ids show the new status
	// in cache, selection retains only the failed ids, and the bulk bar surfaces
	// an error naming the failed count. The list cache is invalidated so a
	// refetch will reconcile the failed rows' status; this test locks the
	// selection-and-toast contract on top of that invalidation.
	it('AC-T4 partial failure — ok ids patched, selection kept only for failed ids, error names failed count', async () => {
		vi.mocked(api.objects.bulkUpdate).mockResolvedValue({
			results: [
				{ id: 'obj-1', ok: true },
				{ id: 'obj-2', ok: true },
				{ id: 'obj-3', ok: true },
				{ id: 'obj-4', ok: false, error: "Invalid status 'done' for type 'bet'" },
				{ id: 'obj-5', ok: false, error: "Invalid status 'done' for type 'bet'" },
			],
		})

		const { queryClient } = renderWithClient(
			<Harness initialSelection={['obj-1', 'obj-2', 'obj-3', 'obj-4', 'obj-5']} />,
		)
		const key = queryKeys.objects.listInfinite(workspaceId, {})
		queryClient.setQueryData(key, {
			pages: [
				[
					buildObject({ id: 'obj-1', status: 'todo', type: 'task' }),
					buildObject({ id: 'obj-2', status: 'todo', type: 'task' }),
					buildObject({ id: 'obj-3', status: 'todo', type: 'task' }),
					buildObject({ id: 'obj-4', status: 'todo', type: 'bet' }),
					buildObject({ id: 'obj-5', status: 'todo', type: 'bet' }),
				],
			],
			pageParams: [0],
		})

		pickStatus('Done')

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				'3 of 5 updated; 2 failed',
				expect.objectContaining({ description: "Invalid status 'done' for type 'bet'" }),
			),
		)
		await waitFor(() => expect(screen.getByTestId('selection-ids').textContent).toBe('obj-4,obj-5'))

		const rows = queryClient.getQueryData<{ pages: ObjectResponse[][] }>(key)?.pages[0] ?? []
		expect(rows.find((r) => r.id === 'obj-1')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-2')?.status).toBe('done')
		expect(rows.find((r) => r.id === 'obj-3')?.status).toBe('done')
		// obj-4 / obj-5 stay optimistically patched until the list-invalidation
		// refetch delivers ground truth. The wire contract we're locking here is:
		// selection is trimmed to the failed ids so the operator can retry.
	})
})
