import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

// This suite pins the fix for the bug Magnus flagged: on a workspace with more
// than one page of objects, every type-tab must stay visible even if the type
// isn't present in the first PAGE_SIZE (50) loaded rows. Tabs are hidden ONLY
// once the infinite query has drained — a `count === 0` on partial data isn't
// evidence that the workspace never uses the type. Empty workspaces still
// collapse to `All`, because their first page is under PAGE_SIZE and
// `hasNextPage` is false immediately.

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

const infiniteState = vi.hoisted(() => ({
	pages: [] as Array<Array<Record<string, unknown>>>,
	hasNextPage: false as boolean,
	isLoading: false as boolean,
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => searchState.current,
		useNavigate: () => vi.fn(),
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: buildWorkspaceWithRole({
			settings: { statuses: { bet: ['active'], task: ['todo'], insight: ['open'] } },
		}),
	}),
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))
vi.mock('@/hooks/use-enabled-modules', () => ({ useEnabledModules: () => [] }))
vi.mock('@/hooks/use-custom-extensions', () => ({ useCustomExtensions: () => [] }))
vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [
		{ label: 'Bets', value: 'bet' },
		{ label: 'Tasks', value: 'task' },
		{ label: 'Insights', value: 'insight' },
	],
	getAllWebModules: () => [],
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-query')>()
	return {
		...actual,
		useQuery: (options: { queryKey?: readonly unknown[] }) => ({
			data: options?.queryKey?.[1] === 'board' ? { columns: [] } : [],
			isLoading: false,
			isSuccess: true,
			isError: false,
		}),
		useInfiniteQuery: () => ({
			data: { pages: infiniteState.pages },
			hasNextPage: infiniteState.hasNextPage,
			isFetchingNextPage: false,
			isError: false,
			fetchNextPage: vi.fn(),
			isLoading: infiniteState.isLoading,
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

vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: vi.fn() }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: null, isSuccess: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/components/objects/bulk-action-bar', () => ({ BulkActionBar: () => null }))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title, titleTabs }: { title?: string; titleTabs?: React.ReactNode }) => (
		<div>
			<h1>{title}</h1>
			<div data-testid="page-title-tabs">{titleTabs}</div>
		</div>
	),
}))
vi.mock('@/components/objects/list/list-view', () => ({
	ListView: () => <div data-testid="list-view" />,
}))
vi.mock('@/components/objects/board/board-view', () => ({
	BoardView: () => <div data-testid="board-view" />,
}))
vi.mock('@/components/objects/data-table/data-table-toolbar', () => ({
	DataTableToolbar: () => <div data-testid="toolbar" />,
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

const RouteOptions = Route as unknown as { component: React.FC }
const ObjectsPage = RouteOptions.component

beforeEach(() => {
	searchState.current = {
		type: undefined,
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
	infiniteState.pages = []
	infiniteState.hasNextPage = false
	infiniteState.isLoading = false
})

describe('ObjectsPage type-tab strip — lazy-load safety', () => {
	it('keeps every enabled type-tab visible while more pages could still load', () => {
		// First page is full (50 bet rows) and more pages exist. Task/Insight are
		// enabled types but 0 of them landed on page 1. Before the fix, both tabs
		// would be pruned by `count === 0` and the user couldn't switch to them.
		infiniteState.pages = [Array.from({ length: 50 }, (_, i) => ({ id: `b-${i}`, type: 'bet' }))]
		infiniteState.hasNextPage = true

		render(<ObjectsPage />)

		expect(screen.getByRole('button', { name: 'Bets (50)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Tasks (0)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Insights (0)' })).toBeInTheDocument()
	})

	it('keeps every enabled type-tab visible while the first page is still loading', () => {
		infiniteState.pages = []
		infiniteState.hasNextPage = false
		infiniteState.isLoading = true

		render(<ObjectsPage />)

		expect(screen.getByRole('button', { name: 'Bets (0)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Tasks (0)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Insights (0)' })).toBeInTheDocument()
	})

	it('prunes a genuinely unused type-tab once the infinite query has drained', () => {
		// Workspace has bet rows only, and every page has landed
		// (`hasNextPage: false`, `isLoading: false`). Only then is it safe to hide
		// tabs whose count is truly zero — the mockup rule that keeps an empty
		// workspace at one `All` tab.
		infiniteState.pages = [[{ id: 'b-1', type: 'bet' }]]
		infiniteState.hasNextPage = false
		infiniteState.isLoading = false

		render(<ObjectsPage />)

		expect(screen.getByRole('button', { name: 'All (1)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Bets (1)' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Tasks (0)' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Insights (0)' })).toBeNull()
	})

	it('collapses an empty workspace to the All tab (single-tab baseline)', () => {
		infiniteState.pages = [[]]
		infiniteState.hasNextPage = false
		infiniteState.isLoading = false

		render(<ObjectsPage />)

		expect(screen.getByRole('button', { name: 'All (0)' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Bets (0)' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Tasks (0)' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Insights (0)' })).toBeNull()
	})
})
