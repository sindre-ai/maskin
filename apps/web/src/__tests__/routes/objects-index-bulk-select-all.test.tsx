// Regression cover for the bulk bar's `Select all` / `Ask an agent`, which
// shipped as component props with no call site — the bar rendered them dead.
// The case that matters is the one a unit test on the bar itself cannot reach:
// select-all must fill from the *rendered* rows, so it never reaches past the
// Attention quick filter into rows the user cannot see.
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

// Follow-up to T5: when the DisplayPanel "Include archived" toggle is on, the
// desktop chip strip should surface `Include: archived ✕` alongside the
// existing Status/Driver chips so users can dismiss the flag without opening
// the popover. The chip is bet-only (mirrors `supportsIncludeArchived`), and
// "Clear all" must clear the archived flag along with status/driver.
const searchState = vi.hoisted(() => ({
	current: {
		type: undefined as string | undefined,
		status: undefined as string | undefined,
		driver: undefined as string | undefined,
		sort: 'createdAt' as string,
		order: 'desc' as 'asc' | 'desc',
		q: undefined as string | undefined,
		groupBy: undefined as string | undefined,
		includeArchived: undefined as 1 | undefined,
		filterBy: undefined as 'status' | 'driver' | 'attention' | undefined,
		attention: undefined as 'waiting' | 'working' | undefined,
	},
}))
const navigateMock = vi.hoisted(() => vi.fn())
const rows = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => searchState.current,
		useNavigate: () => navigateMock,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: buildWorkspaceWithRole({
			settings: { statuses: { bet: ['active', 'archived'] } },
		}),
	}),
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))
vi.mock('@/hooks/use-enabled-modules', () => ({ useEnabledModules: () => [] }))
vi.mock('@/hooks/use-custom-extensions', () => ({ useCustomExtensions: () => [] }))
vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [{ label: 'Bets', value: 'bet' }],
	getAllWebModules: () => [],
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-query')>()
	return {
		...actual,
		// Unlike the sibling suites, this one renders real bet rows, so the
		// bet-status memo actually runs and needs arrays (tasks, relationships)
		// rather than a board payload for everything.
		useQuery: (options: { queryKey?: readonly unknown[] }) => ({
			data:
				options?.queryKey?.[0] === 'objects' && options?.queryKey?.[1] === 'board'
					? { columns: [] }
					: [],
			isLoading: false,
			isSuccess: true,
			isError: false,
		}),
		useInfiniteQuery: () => ({
			data: { pages: [rows.current] },
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

const bulkUpdateCapture = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: bulkUpdateCapture.mutate }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))

const toastCapture = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({
	toast: { error: toastCapture.error, success: toastCapture.success },
}))

const displaySettings = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: displaySettings.current, isSuccess: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn() }),
}))

// Capture the bulk bar's props so the Archive gate can be asserted without
// driving a selection through the mocked ListView.
const bulkBarCapture = vi.hoisted(() => ({ lastProps: null as Record<string, unknown> | null }))
vi.mock('@/components/objects/bulk-action-bar', () => ({
	BulkActionBar: (props: Record<string, unknown>) => {
		bulkBarCapture.lastProps = props
		return null
	},
}))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({
		title,
		subtitle,
		actions,
	}: {
		title?: string
		subtitle?: string
		actions?: React.ReactNode
	}) => (
		<div data-testid="page-header">
			<h1>{title}</h1>
			<span data-testid="page-subtitle">{subtitle}</span>
			{actions}
		</div>
	),
}))
vi.mock('@/components/objects/list/list-view', () => ({
	ListView: () => <div data-testid="list-view" />,
}))
// Capture the board's props so the single-card `→` advance handler can be
// driven directly — the real BoardView is stubbed out in this suite.
const boardCapture = vi.hoisted(() => ({ lastProps: null as Record<string, unknown> | null }))
vi.mock('@/components/objects/board/board-view', () => ({
	BoardView: (props: Record<string, unknown>) => {
		boardCapture.lastProps = props
		return <div data-testid="board-view" />
	},
}))
// The chip strip now lives inside the toolbar's single control row (mockup
// 907–921), so the stand-in renders exactly what the route hands it.
vi.mock('@/components/objects/data-table/data-table-toolbar', () => ({
	DataTableToolbar: ({
		filterPills,
		onClearAllFilters,
		axisChips,
		axisValue,
		onAxisValueChange,
		filterBy,
	}: {
		filterPills?: Array<{ id: string; label: string; value: string; onRemove: () => void }>
		onClearAllFilters?: () => void
		axisChips?: Array<{ label: string; value: string | undefined; count?: number }>
		axisValue?: string
		onAxisValueChange?: (value: string | undefined) => void
		filterBy?: string
	}) => (
		<div data-testid="toolbar" data-filter-by={filterBy} data-axis-value={axisValue}>
			{(axisChips ?? []).map((chip) => (
				<button
					key={chip.label}
					type="button"
					data-testid="axis-chip"
					onClick={() => onAxisValueChange?.(chip.value)}
				>
					{chip.label}
					{chip.count !== undefined ? ` ${chip.count}` : ''}
				</button>
			))}
			{(filterPills ?? []).map((pill) => (
				<span key={pill.id}>
					<span>{pill.label}:</span>
					<span>{pill.value}</span>
					<button
						type="button"
						aria-label={`Remove ${pill.label} filter`}
						onClick={pill.onRemove}
					/>
				</span>
			))}
			<button type="button" onClick={onClearAllFilters}>
				Clear all
			</button>
		</div>
	),
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
vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
	trackObjectsListArrived: vi.fn(),
	trackObjectsListGroupToggled: vi.fn(),
	trackObjectsBoardArrived: vi.fn(),
}))
vi.mock('@/lib/back-nav-tracker', () => ({
	consumeArrivalNavType: vi.fn().mockReturnValue('direct'),
	initBackNavTracker: vi.fn(),
}))
vi.mock('@/lib/query-keys', () => ({
	queryKeys: {
		objects: {
			list: (workspaceId: string, filters?: unknown) => ['objects', workspaceId, 'list', filters],
			listInfinite: () => ['objects'],
			board: () => ['objects', 'board'],
		},
		relationships: { all: (workspaceId: string) => ['relationships', workspaceId] },
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

import { Route } from '@/routes/_authed/$workspaceId/objects/index'

beforeEach(() => {
	localStorage.setItem('ff:new-design', 'on')
})

const RouteOptions = Route as unknown as { component: React.FC }
const ObjectsPage = RouteOptions.component

const WAITING = {
	id: 'obj-waiting',
	type: 'bet',
	title: 'Waiting on you',
	status: 'active',
	workspaceId: 'ws-1',
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
}
const WORKING = { ...WAITING, id: 'obj-working', title: 'Agent working', activeSessionId: 'sess-1' }
const IDLE = { ...WAITING, id: 'obj-idle', title: 'Nothing happening' }

beforeEach(() => {
	vi.clearAllMocks()
	bulkBarCapture.lastProps = null
	rows.current = [WAITING, WORKING, IDLE]
	displaySettings.current = null
	searchState.current = {
		type: 'bet',
		status: undefined,
		driver: undefined,
		sort: 'createdAt',
		order: 'desc',
		q: undefined,
		groupBy: undefined,
		includeArchived: undefined,
		filterBy: undefined,
		attention: undefined,
	}
})

describe('objects route — bulk select all / ask an agent', () => {
	it('offers select-all across every rendered row when no quick filter is active', async () => {
		render(<ObjectsPage />)
		await waitFor(() => expect(bulkBarCapture.lastProps).not.toBeNull())

		expect(bulkBarCapture.lastProps?.totalCount).toBe(3)
		expect(typeof bulkBarCapture.lastProps?.onSelectAll).toBe('function')
		expect(typeof bulkBarCapture.lastProps?.onAskAgent).toBe('function')
	})

	it('never reaches past the Attention filter into rows the list is hiding', async () => {
		searchState.current = { ...searchState.current, filterBy: 'attention', attention: 'working' }
		render(<ObjectsPage />)
		await waitFor(() => expect(bulkBarCapture.lastProps).not.toBeNull())

		// Only `WORKING` is rendered under `attention=working`.
		expect(bulkBarCapture.lastProps?.totalCount).toBe(1)

		await act(async () => {
			;(bulkBarCapture.lastProps?.onSelectAll as () => void)()
		})
		await waitFor(() => expect(bulkBarCapture.lastProps?.selectedCount).toBe(1))
	})

	it('hands the selection to a new chat as references', async () => {
		render(<ObjectsPage />)
		await waitFor(() => expect(bulkBarCapture.lastProps).not.toBeNull())

		await act(async () => {
			;(bulkBarCapture.lastProps?.onSelectAll as () => void)()
		})
		await waitFor(() => expect(bulkBarCapture.lastProps?.selectedCount).toBe(3))

		await act(async () => {
			;(bulkBarCapture.lastProps?.onAskAgent as () => void)()
		})

		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/chats/new',
				search: { objectIds: 'obj-waiting,obj-working,obj-idle' },
			}),
		)
	})
})
