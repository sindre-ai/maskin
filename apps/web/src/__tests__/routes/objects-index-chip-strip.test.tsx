import { render, screen, waitFor } from '@testing-library/react'
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
		useQuery: (options: { queryKey?: readonly unknown[] }) => ({
			data: options?.queryKey?.[0] === 'notifications' ? [] : { columns: [] },
			isLoading: false,
			isSuccess: true,
			isError: false,
		}),
		useInfiniteQuery: () => ({
			data: { pages: [[]] },
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

vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: vi.fn() }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))

vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: null, isSuccess: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/components/objects/bulk-action-bar', () => ({ BulkActionBar: () => null }))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
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
		type: 'bet',
		status: undefined,
		driver: undefined,
		sort: 'createdAt',
		order: 'desc',
		q: undefined,
		groupBy: undefined,
		includeArchived: undefined,
	}
	navigateMock.mockClear()
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

	it('renders the chip strip when only the archived flag is on (no status/driver)', () => {
		searchState.current.includeArchived = 1
		render(<ObjectsPage />)
		expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
	})
})
