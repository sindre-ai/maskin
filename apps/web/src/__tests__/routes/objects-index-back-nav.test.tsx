import type { ObjectResponse } from '@/lib/api'
import { __resetObjectsViewStateForTesting, patchViewState } from '@/lib/objects-view-state'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildObjectResponse, buildWorkspaceWithRole } from '../factories'

// vi.mock is hoisted above `import` — anything the factory closes over must
// come from vi.hoisted() so it's live at hoist time.
const scrollToRowIdMock = vi.hoisted(() => vi.fn())

// Router mock — no navigation happens in these tests; just satisfy the imports.
vi.mock('@/lib/back-nav-tracker', () => ({
	wasRecentBackNav: vi.fn(),
	initBackNavTracker: vi.fn(),
	consumeArrivalNavType: vi.fn(),
}))

vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackObjectsListArrived: vi.fn(),
		trackObjectsListGroupToggled: vi.fn(),
		trackEvent: vi.fn(),
	}
})

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => ({
			type: undefined,
			status: undefined,
			driver: undefined,
			sort: 'createdAt',
			order: 'desc',
			q: undefined,
			groupBy: undefined,
		}),
		useNavigate: () => vi.fn(),
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: buildWorkspaceWithRole({ settings: {} }),
	}),
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))
vi.mock('@/hooks/use-enabled-modules', () => ({ useEnabledModules: () => [] }))
vi.mock('@/hooks/use-custom-extensions', () => ({ useCustomExtensions: () => [] }))
vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [],
	getAllWebModules: () => [],
}))
vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: vi.fn() }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: null, isSuccess: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn() }),
}))

// Three seed rows; the same list is served regardless of hook call so that
// selection can lock onto a stable id across remounts. Insights (not bets) so
// the route's `hasVisibleBets` gate stays false — otherwise the workspaceTasks
// / breaksIntoRels branches would fire useQuery calls that don't match our
// stub shape.
const rows: ObjectResponse[] = [
	buildObjectResponse({ id: 'obj-a', title: 'Alpha', type: 'insight' }),
	buildObjectResponse({ id: 'obj-b', title: 'Beta', type: 'insight' }),
	buildObjectResponse({ id: 'obj-c', title: 'Gamma', type: 'insight' }),
]

vi.mock('@tanstack/react-query', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-query')>()
	return {
		...actual,
		useQuery: (options: { queryKey?: readonly unknown[] }) => ({
			data: options?.queryKey?.[0] === 'notifications' ? [] : { columns: [] },
			isLoading: false,
			isSuccess: true,
			isError: false,
		}),
		useInfiniteQuery: () => ({
			data: { pages: [rows] },
			hasNextPage: false,
			isFetchingNextPage: false,
			isError: false,
			fetchNextPage: vi.fn(),
			isLoading: false,
		}),
		useQueryClient: () => ({
			invalidateQueries: vi.fn(),
			getQueriesData: vi.fn(() => []),
			setQueryData: vi.fn(),
			removeQueries: vi.fn(),
			cancelQueries: vi.fn(),
		}),
		useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
	}
})

vi.mock('@/components/objects/bulk-action-bar', () => ({ BulkActionBar: () => null }))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/objects/data-table/data-table-toolbar', () => ({
	DataTableToolbar: () => <div data-testid="dtt" />,
}))
vi.mock('@/components/objects/data-table/columns', () => ({ getStaticColumns: () => [] }))
vi.mock('@/components/objects/data-table/dynamic-columns', () => ({ getDynamicColumns: () => [] }))
vi.mock('@/components/imports/import-dialog', () => ({ ImportDialog: () => null }))
vi.mock('@/hooks/use-imports', () => ({ useImportToast: () => ({ startTracking: vi.fn() }) }))
vi.mock('@/components/shared/route-error', () => ({ RouteError: () => <div>Error</div> }))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

vi.mock('@/lib/api', () => ({
	api: { objects: { list: vi.fn(), search: vi.fn() }, notifications: { list: vi.fn() } },
}))

vi.mock('@/lib/query-keys', () => ({
	queryKeys: {
		objects: {
			list: (workspaceId: string, filters?: unknown) => ['objects', workspaceId, 'list', filters],
			listInfinite: () => ['objects'],
			board: () => ['objects', 'board'],
		},
		relationships: {
			all: (workspaceId: string) => ['relationships', workspaceId],
		},
		imports: { detail: (id: string) => ['imports', 'detail', id] },
		notifications: {
			all: (workspaceId: string) => ['notifications', workspaceId],
			list: (workspaceId: string, filters?: Record<string, unknown>) => [
				'notifications',
				workspaceId,
				'list',
				filters,
			],
			detail: (id: string) => ['notifications', 'detail', id],
		},
		userDisplaySettings: {
			detail: (workspaceId: string, objectType: string) => [
				'user-display-settings',
				workspaceId,
				objectType,
			],
			list: (workspaceId: string) => ['user-display-settings', workspaceId],
		},
	},
}))

// ListView stub — reflects the current rowSelection prop into the DOM so tests
// can observe it, exposes a button to drive onRowSelectionChange, calls
// onCaptureViewState on row click, and provides an imperative handle whose
// getFirstVisibleRowId is fixed to the first seed row (mirrors what the real
// list's first-visible-row probe would return with all rows on-screen).
vi.mock('@/components/objects/list/list-view', async () => {
	const { forwardRef, useImperativeHandle } = await import('react')
	type Props = {
		data: Array<{ id: string }>
		rowSelection: Record<string, boolean>
		onRowSelectionChange: (
			updater: (prev: Record<string, boolean>) => Record<string, boolean>,
		) => void
		onCaptureViewState?: () => void
	}
	const ListView = forwardRef<
		{ getFirstVisibleRowId: () => string | null; scrollToRowId: (id: string) => void },
		Props
	>(function ListViewStub({ data, rowSelection, onRowSelectionChange, onCaptureViewState }, ref) {
		useImperativeHandle(
			ref,
			() => ({
				getFirstVisibleRowId: () => data[0]?.id ?? null,
				scrollToRowId: (id: string) => scrollToRowIdMock(id),
			}),
			[data],
		)
		const selectedIds = Object.keys(rowSelection).join(',')
		return (
			<div>
				<div data-testid="selected-ids">{selectedIds}</div>
				<button
					type="button"
					onClick={() => onRowSelectionChange((prev) => ({ ...prev, 'obj-a': true }))}
				>
					select row 0
				</button>
				<button type="button" onClick={() => onCaptureViewState?.()}>
					open row 0
				</button>
			</div>
		)
	})
	return { ListView }
})

import { Route } from '@/routes/_authed/$workspaceId/objects/index'

const RouteOptions = Route as unknown as { component: React.FC }
const ObjectsPage = RouteOptions.component

async function setBackNav(isBack: boolean) {
	const { wasRecentBackNav, consumeArrivalNavType } = await import('@/lib/back-nav-tracker')
	vi.mocked(wasRecentBackNav).mockReturnValue(isBack)
	vi.mocked(consumeArrivalNavType).mockReturnValue(isBack ? 'back' : 'link')
}

beforeEach(() => {
	__resetObjectsViewStateForTesting()
	scrollToRowIdMock.mockClear()
})

describe('ObjectsPage — silent scroll restore on POP landing', () => {
	it('calls scrollToRowId with the persisted first-visible row id when the mount was a POP and data has loaded', async () => {
		patchViewState('ws-1', '__all__', { firstVisibleRowId: 'obj-b' })
		await setBackNav(true)

		render(<ObjectsPage />)

		// Restore effect gates on rows loaded + POP; both are true, so exactly
		// one scrollToRowId call fires with the persisted id.
		expect(scrollToRowIdMock).toHaveBeenCalledTimes(1)
		expect(scrollToRowIdMock).toHaveBeenCalledWith('obj-b')
	})

	it('does nothing on a PUSH/REPLACE landing even if a stale anchor lingers in the store', async () => {
		patchViewState('ws-1', '__all__', { firstVisibleRowId: 'obj-b' })
		await setBackNav(false)

		render(<ObjectsPage />)

		expect(scrollToRowIdMock).not.toHaveBeenCalled()
	})

	it('stays silent when the mount was a POP but the store has no anchor for this key', async () => {
		await setBackNav(true)

		render(<ObjectsPage />)

		// The gate flipped (POP + data loaded), but firstVisibleRowId is null
		// so the restore is a no-op — no scrollToRowId call, no fallback.
		expect(scrollToRowIdMock).not.toHaveBeenCalled()
	})
})

describe('ObjectsPage — capture on navigate-away', () => {
	it('writes the current first-visible row id into the session store when the click handler fires', async () => {
		const user = userEvent.setup()
		await setBackNav(false)

		render(<ObjectsPage />)

		await user.click(screen.getByRole('button', { name: /open row 0/i }))

		// Simulate the eventual POP back — the anchor written on click should
		// be readable from the store and drive scrollToRowId.
		await setBackNav(true)
		scrollToRowIdMock.mockClear()

		render(<ObjectsPage />)

		expect(scrollToRowIdMock).toHaveBeenCalledWith('obj-a')
	})
})

describe('ObjectsPage — row selection is NOT restored across back-nav (bet AC bullet 4 regression guard)', () => {
	it('a selected row on the first mount reads back as empty selection on a POP-triggered remount', async () => {
		const user = userEvent.setup()
		await setBackNav(false)

		const { unmount } = render(<ObjectsPage />)

		// Sanity: fresh mount has no selection.
		expect(screen.getByTestId('selected-ids').textContent).toBe('')

		// Select the first row — the mocked ListView drives
		// onRowSelectionChange the same way the real checkbox would.
		await act(async () => {
			await user.click(screen.getByRole('button', { name: /select row 0/i }))
		})
		expect(screen.getByTestId('selected-ids').textContent).toBe('obj-a')

		// Simulate a browser back-nav: unmount the route, then mount it fresh
		// with wasRecentBackNav → true. The regression guard fires here — if
		// some future refactor persisted selection to a session store, the
		// remount would rehydrate it and this assertion would fail.
		unmount()
		await setBackNav(true)

		render(<ObjectsPage />)

		expect(screen.getByTestId('selected-ids').textContent).toBe('')
	})
})
