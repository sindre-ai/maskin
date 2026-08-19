import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
		// Only the board query returns `{ columns }`. The rest (tasks and
		// breaks_into rels, which feed the bet-status derivation) are mapped
		// over, so they have to be arrays.
		useQuery: (options: { queryKey?: readonly unknown[] }) => ({
			data: options?.queryKey?.[1] === 'board' ? { columns: [] } : [],
			isLoading: false,
			isSuccess: true,
			isError: false,
		}),
		useInfiniteQuery: () => ({
			data: { pages: [objectsState.rows] },
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

// Rows the infinite query hands back. Mutable so a test can load a list without
// re-mocking the query layer; defaults to empty, which is what every test that
// only cares about the chip strip expects.
const objectsState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

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
	// The type tabs go out as `titleTabs` (the nav row's left cluster, beside
	// the <h1>), not as `actions` — the stand-in renders both so a regression
	// back to the right-hand cluster shows up here.
	PageHeader: ({
		title,
		subtitle,
		actions,
		titleTabs,
	}: {
		title?: string
		subtitle?: string
		actions?: React.ReactNode
		titleTabs?: React.ReactNode
	}) => (
		<div data-testid="page-header">
			<h1>{title}</h1>
			<span data-testid="page-subtitle">{subtitle}</span>
			<span data-testid="page-title-tabs">{titleTabs}</span>
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

// The v2 Objects page sits behind `new-design`; these specs cover that branch,
// so they drive the flag on through the test-only localStorage override. The
// pre-v2 branch is covered by its own spec.
beforeEach(() => {
	localStorage.setItem('ff:new-design', 'on')
})

const RouteOptions = Route as unknown as { component: React.FC }
const ObjectsPageComponent = RouteOptions.component
const ObjectsPage = ObjectsPageComponent

beforeEach(() => {
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
	navigateMock.mockClear()
	objectsState.rows = []
	bulkBarCapture.lastProps = null
})

describe('ObjectsPage chip strip — Include: archived', () => {
	it('renders the chip when the archived toggle is on and the bet tab is active', () => {
		searchState.current.includeArchived = 1
		render(<ObjectsPage />)
		// FilterChip renders `<span>{label:}<span/><span>{value}</span><button/></span>`;
		// walk up from the label to the outer wrapper before asserting on value.
		const chip = screen.getByText('Include:').parentElement
		expect(chip).not.toBeNull()
		expect(chip?.textContent).toContain('archived')
		expect(screen.getByRole('button', { name: /Remove Include filter/i })).toBeInTheDocument()
	})

	it('hides the chip when the archived toggle is off', () => {
		searchState.current.includeArchived = undefined
		render(<ObjectsPage />)
		expect(screen.queryByText('Include:')).toBeNull()
	})

	it('hides the chip on non-bet tabs even if the URL carries the flag', () => {
		searchState.current.type = 'task'
		searchState.current.includeArchived = 1
		render(<ObjectsPage />)
		expect(screen.queryByText('Include:')).toBeNull()
	})

	it("clears only the archived flag when the chip's remove button is clicked", async () => {
		const user = userEvent.setup()
		searchState.current.includeArchived = 1
		searchState.current.status = 'active'
		render(<ObjectsPage />)

		await user.click(screen.getByRole('button', { name: /Remove Include filter/i }))

		await waitFor(() => expect(navigateMock).toHaveBeenCalled())
		const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
		expect(lastCall?.[0].search).not.toHaveProperty('includeArchived')
		expect(lastCall?.[0].search.status).toBe('active')
	})

	it('clears the archived flag alongside status/driver when "Clear all" is clicked', async () => {
		const user = userEvent.setup()
		searchState.current.includeArchived = 1
		searchState.current.status = 'active'
		searchState.current.driver = 'actor-1'
		render(<ObjectsPage />)

		await user.click(screen.getByRole('button', { name: 'Clear all' }))

		await waitFor(() => expect(navigateMock).toHaveBeenCalled())
		const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
		expect(lastCall?.[0].search).not.toHaveProperty('includeArchived')
		expect(lastCall?.[0].search).not.toHaveProperty('status')
		expect(lastCall?.[0].search).not.toHaveProperty('driver')
	})

	// "Clear all" itself is gated on >1 active pill in the toolbar (mockup 920's
	// `objPillsMany`), so the single-filter case asserts the pill, not the action.
	// Archive must not be offered where `Show archived` isn't: an archived task
	// or insight would leave the list with no toggle to bring it back.
	it('offers the bulk Archive action on the bet tab and withholds it elsewhere', () => {
		searchState.current.type = 'bet'
		render(<ObjectsPage />)
		expect(bulkBarCapture.lastProps?.onArchive).toBeTypeOf('function')

		searchState.current.type = 'task'
		render(<ObjectsPage />)
		expect(bulkBarCapture.lastProps?.onArchive).toBeUndefined()
	})

	it('renders the chip strip when only the archived flag is on (no status/driver)', () => {
		searchState.current.includeArchived = 1
		render(<ObjectsPage />)
		expect(screen.getByText('Include:')).toBeInTheDocument()
	})
})

// Mockup 907–911 / 932–937: one chip row driven by the active FILTER BY axis,
// and the screen's identity published to the shared nav row (165–170).
describe('ObjectsPage — FILTER BY axis chips', () => {
	it('defaults to the Status axis and derives its value chips from the loaded rows', () => {
		render(<ObjectsPage />)
		expect(screen.getByTestId('toolbar')).toHaveAttribute('data-filter-by', 'status')
		const labels = screen.getAllByTestId('axis-chip').map((el) => el.textContent)
		expect(labels).toContain('All')
		expect(labels).toContain('active 0')
		expect(labels).toContain('archived 0')
	})

	it('offers the Attention axis values when filterBy=attention', () => {
		searchState.current.filterBy = 'attention'
		render(<ObjectsPage />)
		const labels = screen.getAllByTestId('axis-chip').map((el) => el.textContent)
		expect(labels).toEqual(['All', 'Waiting on you 0', 'Agent working 0'])
	})

	it('writes the picked value to the axis parameter', async () => {
		const user = userEvent.setup()
		render(<ObjectsPage />)
		await user.click(screen.getByRole('button', { name: 'active 0' }))
		await waitFor(() => expect(navigateMock).toHaveBeenCalled())
		const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
		expect(lastCall?.[0].search.status).toBe('active')
	})

	it('clears the axis when the already-active chip is picked again', async () => {
		const user = userEvent.setup()
		searchState.current.status = 'active'
		render(<ObjectsPage />)
		expect(screen.getByTestId('toolbar')).toHaveAttribute('data-axis-value', 'active')
		await user.click(screen.getByRole('button', { name: 'active 0' }))
		await waitFor(() => expect(navigateMock).toHaveBeenCalled())
		const lastCall = navigateMock.mock.calls.at(-1) as [{ search: Record<string, unknown> }]
		expect(lastCall?.[0].search).not.toHaveProperty('status')
	})
})

describe('ObjectsPage — published screen identity', () => {
	it('publishes the Objects title, the row count, and the type-tab strip', () => {
		render(<ObjectsPage />)
		expect(screen.getByRole('heading', { name: 'Objects' })).toBeInTheDocument()
		expect(screen.getByTestId('page-subtitle')).toHaveTextContent('0')
		expect(screen.getByRole('group', { name: 'Type filter' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Bets (0)' })).toBeInTheDocument()
	})
})

// The bulk endpoint reports per-row failures as HTTP 200 with
// `results:[{ok:false,error}]`, so `onError` never fires for them. Without an
// explicit `ok` check the optimistic patch sits there until `onSettled`
// refetches and the card snaps back silently — the shape the drag path in
// `board-view.tsx` already guards against.
describe('ObjectsPage — board single-card advance', () => {
	beforeEach(() => {
		bulkUpdateCapture.mutate.mockReset()
		toastCapture.error.mockReset()
		boardCapture.lastProps = null
		displaySettings.current = null
	})

	function advance() {
		// The board branch is gated on a resolved type filter with configured
		// statuses; the view itself comes from persisted display settings, not
		// the search param.
		searchState.current.type = 'bet'
		displaySettings.current = { settings: { view: 'board' } }
		render(<ObjectsPage />)
		const onAdvance = boardCapture.lastProps?.onAdvance as (id: string, status: string) => void
		expect(onAdvance).toBeTypeOf('function')
		onAdvance('obj-1', 'done')
		return bulkUpdateCapture.mutate.mock.calls.at(-1) as [
			unknown,
			{
				onSuccess?: (d: { results: Array<{ id: string; ok: boolean; error?: string }> }) => void
				onError?: (e: Error) => void
			},
		]
	}

	it('toasts the server error when the response reports a per-id failure', () => {
		const [, opts] = advance()
		opts.onSuccess?.({ results: [{ id: 'obj-1', ok: false, error: "Invalid status 'done'" }] })
		expect(toastCapture.error).toHaveBeenCalledWith("Invalid status 'done'")
	})

	it('toasts when the response omits the advanced id entirely', () => {
		const [, opts] = advance()
		opts.onSuccess?.({ results: [{ id: 'other', ok: true }] })
		expect(toastCapture.error).toHaveBeenCalledWith('Failed to move object')
	})

	it('stays silent when the server confirms the move', () => {
		const [, opts] = advance()
		opts.onSuccess?.({ results: [{ id: 'obj-1', ok: true }] })
		expect(toastCapture.error).not.toHaveBeenCalled()
	})

	it('toasts when the mutation itself rejects', () => {
		const [, opts] = advance()
		opts.onError?.(new Error('Network blew up'))
		expect(toastCapture.error).toHaveBeenCalledWith('Failed to move object')
	})
})

describe('ObjectsPage bulk edit', () => {
	it("publishes the type tabs into the nav row's left cluster, not its actions slot", () => {
		render(<ObjectsPage />)

		// `titleTabs` lands beside the <h1>; `actions` lands past the search
		// field. The tabs belong in the first (mockup 146-153).
		expect(screen.getByTestId('page-title-tabs').textContent).not.toBe('')
	})
})
