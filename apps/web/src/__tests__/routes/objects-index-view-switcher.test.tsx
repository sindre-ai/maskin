import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

// Capture the toolbar props so the test can drive the view switcher the same
// way DisplayPanel would in the live app — without mounting the full panel.
const toolbarProps: { current: Record<string, unknown> | null } = { current: null }
const infiniteQueryState = vi.hoisted(() => ({
	fetchNextPage: vi.fn(),
	hasNextPage: false,
	isFetchingNextPage: false,
	isError: false,
	observerCallback: null as IntersectionObserverCallback | null,
}))
const boardQueryState = vi.hoisted(() => ({
	columns: [
		{
			value: 'todo',
			label: 'todo',
			objects: [] as Array<{ id: string }>,
			total: 0,
		},
	],
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => ({
			type: 'task',
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
		workspace: buildWorkspaceWithRole({
			settings: { statuses: { task: ['todo', 'in_progress', 'done'] } },
		}),
	}),
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))
vi.mock('@/hooks/use-enabled-modules', () => ({ useEnabledModules: () => [] }))
vi.mock('@/hooks/use-custom-extensions', () => ({ useCustomExtensions: () => [] }))
vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [{ label: 'Tasks', value: 'task' }],
	getAllWebModules: () => [],
}))
vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: vi.fn() }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-query')>()
	return {
		...actual,
		useQuery: (options: { queryKey?: readonly unknown[] }) => ({
			data: options?.queryKey?.[0] === 'notifications' ? [] : { columns: boardQueryState.columns },
			isLoading: false,
			isSuccess: true,
			isError: false,
		}),
		useInfiniteQuery: () => ({
			data: { pages: [[]] },
			hasNextPage: infiniteQueryState.hasNextPage,
			isFetchingNextPage: infiniteQueryState.isFetchingNextPage,
			isError: infiniteQueryState.isError,
			fetchNextPage: infiniteQueryState.fetchNextPage,
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

// Persisted settings shape — flipped per test via the global below.
const persisted: { current: { view?: 'list' | 'board' } | null } = { current: null }
const upsertMock = vi.fn()

vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({
		data: persisted.current
			? {
					object_type: 'task',
					name: 'default',
					settings: persisted.current,
					updated_at: '2026-05-30T00:00:00.000Z',
				}
			: null,
		isSuccess: true,
	}),
	useUpdateUserDisplaySettings: () => ({ mutate: upsertMock }),
}))

vi.mock('@/components/objects/bulk-action-bar', () => ({ BulkActionBar: () => null }))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/objects/list/list-view', () => ({
	ListView: () => <div data-testid="list-view" />,
}))
vi.mock('@/components/objects/board/board-view', () => ({
	// Mimic the real board column "load more" behavior closely enough for the
	// sentinel test to verify the IntersectionObserver path.
	BoardView: ({
		objectType,
		columns,
	}: {
		objectType: string
		columns?: Array<{ objects?: unknown[]; total?: number }>
	}) => {
		const hasMore = columns?.some((column) => (column.total ?? 0) > (column.objects?.length ?? 0))
		const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null)

		useEffect(() => {
			if (!hasMore || !sentinelEl) return
			const observer = new IntersectionObserver((entries) => {
				if (!entries[0]?.isIntersecting) return
				infiniteQueryState.fetchNextPage()
			})
			observer.observe(sentinelEl)
			return () => observer.disconnect()
		}, [hasMore, sentinelEl])

		return (
			<div data-testid="board-view" data-object-type={objectType}>
				{hasMore ? <div ref={setSentinelEl} data-testid="board-load-more-sentinel" /> : null}
			</div>
		)
	},
}))
vi.mock('@/components/objects/data-table/data-table-toolbar', () => ({
	DataTableToolbar: (props: Record<string, unknown>) => {
		toolbarProps.current = props
		return <div data-testid="toolbar" />
	},
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
			listInfinitePrefix: () => ['objects', 'infinite'],
			listPrefix: () => ['objects', 'list'],
			board: () => ['objects', 'board'],
			detail: (id: string) => ['objects', 'detail', id],
			all: () => ['objects'],
		},
		relationships: {
			all: (workspaceId: string) => ['relationships', workspaceId],
		},
		notifications: {
			list: (workspaceId: string, filters?: unknown) => [
				'notifications',
				workspaceId,
				'list',
				filters,
			],
		},
		bets: { all: () => ['bets'] },
		imports: { detail: (id: string) => ['imports', 'detail', id] },
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

const RouteOptions = Route as unknown as { component: React.FC }
const ObjectsPage = RouteOptions.component

function renderRoute() {
	return render(<ObjectsPage />)
}

beforeEach(() => {
	infiniteQueryState.fetchNextPage.mockClear()
	infiniteQueryState.hasNextPage = false
	infiniteQueryState.isFetchingNextPage = false
	infiniteQueryState.isError = false
	infiniteQueryState.observerCallback = null

	class MockIntersectionObserver {
		constructor(callback: IntersectionObserverCallback) {
			infiniteQueryState.observerCallback = callback
		}
		observe = vi.fn()
		disconnect = vi.fn()
		unobserve = vi.fn()
		takeRecords = () => []
		root = null
		rootMargin = ''
		thresholds = []
	}

	vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

describe('ObjectsPage view switcher', () => {
	it('exposes both list and board options to the toolbar when the type has configured statuses', async () => {
		persisted.current = null
		toolbarProps.current = null
		renderRoute()
		await waitFor(() => expect(toolbarProps.current).not.toBeNull())
		const props = toolbarProps.current as unknown as Record<string, unknown>
		expect(props.boardSupported).toBe(true)
		expect(props.view).toBe('list')
		expect(typeof props.onViewChange).toBe('function')
	})

	it('swaps ListView for BoardView when the toolbar reports a Board selection', async () => {
		persisted.current = null
		toolbarProps.current = null
		renderRoute()
		await waitFor(() => expect(toolbarProps.current).not.toBeNull())
		expect(screen.getByTestId('list-view')).toBeInTheDocument()
		expect(screen.queryByTestId('board-view')).toBeNull()

		act(() => {
			;(toolbarProps.current?.onViewChange as (v: 'list' | 'board') => void)('board')
		})

		await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument())
		expect(screen.queryByTestId('list-view')).toBeNull()
		expect(screen.getByTestId('board-view')).toHaveAttribute('data-object-type', 'task')
	})

	it('hydrates view from persisted display settings (board)', async () => {
		persisted.current = { view: 'board' }
		toolbarProps.current = null
		renderRoute()
		await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument())
		expect(toolbarProps.current).not.toBeNull()
		expect((toolbarProps.current as unknown as Record<string, unknown>).view).toBe('board')
	})

	it('round-trips the chosen view back through the upsert mutation', async () => {
		persisted.current = null
		toolbarProps.current = null
		upsertMock.mockClear()
		renderRoute()
		await waitFor(() => expect(toolbarProps.current).not.toBeNull())

		act(() => {
			;(toolbarProps.current?.onViewChange as (v: 'list' | 'board') => void)('board')
		})
		// Persistence write is debounced 500 ms — wait past that window.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 750))
		})

		expect(upsertMock).toHaveBeenCalled()
		const lastCall = upsertMock.mock.calls.at(-1) as [
			{ objectType: string; settings: { view?: string } },
		]
		expect(lastCall?.[0].objectType).toBe('task')
		expect(lastCall?.[0].settings.view).toBe('board')
	}, 10_000)

	it('fetches the next page when the board scroll sentinel intersects', async () => {
		infiniteQueryState.hasNextPage = true
		boardQueryState.columns = [{ value: 'todo', label: 'todo', objects: [{ id: 'o-1' }], total: 2 }]
		persisted.current = { view: 'board' }
		toolbarProps.current = null
		renderRoute()
		await waitFor(() => expect(screen.getByTestId('board-load-more-sentinel')).toBeInTheDocument())
		expect(infiniteQueryState.observerCallback).toBeTypeOf('function')

		act(() => {
			infiniteQueryState.observerCallback?.(
				[{ isIntersecting: true } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			)
		})

		expect(infiniteQueryState.fetchNextPage).toHaveBeenCalledTimes(1)
	})
})
