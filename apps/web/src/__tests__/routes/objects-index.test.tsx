import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

vi.mock('@/lib/back-nav-tracker', () => ({
	consumeArrivalNavType: vi.fn(),
	initBackNavTracker: vi.fn(),
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

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => [],
}))

vi.mock('@/hooks/use-custom-extensions', () => ({
	useCustomExtensions: () => [],
}))

vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [],
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

vi.mock('@/components/objects/bulk-action-bar', () => ({
	BulkActionBar: () => null,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/objects/list/list-view', () => ({
	ListView: () => <div data-testid="list-view" />,
}))

vi.mock('@/components/objects/data-table/data-table-toolbar', () => ({
	DataTableToolbar: () => <div data-testid="data-table-toolbar" />,
}))

vi.mock('@/components/objects/data-table/columns', () => ({
	getStaticColumns: () => [],
}))

vi.mock('@/components/objects/data-table/dynamic-columns', () => ({
	getDynamicColumns: () => [],
}))

vi.mock('@/components/imports/import-dialog', () => ({
	ImportDialog: () => null,
}))

vi.mock('@/hooks/use-imports', () => ({
	useImportToast: () => ({ startTracking: vi.fn() }),
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

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
		notifications: {
			list: (workspaceId: string, filters?: unknown) => [
				'notifications',
				workspaceId,
				'list',
				filters,
			],
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

import { Route } from '@/routes/_authed/$workspaceId/objects/index'

const RouteOptions = Route as unknown as {
	component: React.FC
	validateSearch: (input: Record<string, unknown>) => Record<string, unknown>
}
const ObjectsPage = RouteOptions.component

describe('validateSearch', () => {
	it('returns defaults for missing params', () => {
		const result = RouteOptions.validateSearch({})
		expect(result).toEqual({
			type: undefined,
			status: undefined,
			driver: undefined,
			sort: 'createdAt',
			order: 'desc',
			q: undefined,
			groupBy: undefined,
		})
	})

	it('parses all search param types correctly', () => {
		const result = RouteOptions.validateSearch({
			type: 'bet',
			status: 'active',
			driver: 'actor-1',
			sort: 'title',
			order: 'asc',
			q: 'search term',
			groupBy: 'status',
		})
		expect(result).toEqual({
			type: 'bet',
			status: 'active',
			driver: 'actor-1',
			sort: 'title',
			order: 'asc',
			q: 'search term',
			groupBy: 'status',
		})
	})

	it('defaults order to desc for invalid values', () => {
		const result = RouteOptions.validateSearch({ order: 'invalid' })
		expect(result.order).toBe('desc')
	})

	it('ignores non-string values', () => {
		const result = RouteOptions.validateSearch({ type: 123, status: true, q: null })
		expect(result.type).toBeUndefined()
		expect(result.status).toBeUndefined()
		expect(result.q).toBeUndefined()
	})

	it('coerces number/boolean metadata.<field> values to strings instead of dropping them', () => {
		// The router's default search parser JSON-parses query values, so a
		// bare `metadata.priority=5` or `metadata.active=true` (e.g. from a
		// hand-typed or externally-built URL) arrives here as a number/boolean.
		const result = RouteOptions.validateSearch({
			'metadata.priority': 5,
			'metadata.active': true,
			'metadata.region': 'emea',
		})
		expect(result['metadata.priority']).toBe('5')
		expect(result['metadata.active']).toBe('true')
		expect(result['metadata.region']).toBe('emea')
	})
})

describe('ObjectsPage', () => {
	it('renders page header and list view', () => {
		render(<ObjectsPage />)
		expect(screen.getByText('Objects')).toBeInTheDocument()
		expect(screen.getByTestId('list-view')).toBeInTheDocument()
		expect(screen.getByTestId('data-table-toolbar')).toBeInTheDocument()
	})
})

describe('ObjectsPage mount-effect arrival event', () => {
	beforeEach(async () => {
		const { trackObjectsListArrived } = await import('@/lib/analytics')
		const { consumeArrivalNavType } = await import('@/lib/back-nav-tracker')
		vi.mocked(trackObjectsListArrived).mockClear()
		vi.mocked(consumeArrivalNavType).mockReset()
	})

	it('fires objects_list_arrived with nav_type=back and objectType=null when the mount was a browser back-nav on the All tab', async () => {
		const { consumeArrivalNavType } = await import('@/lib/back-nav-tracker')
		const { trackObjectsListArrived } = await import('@/lib/analytics')
		vi.mocked(consumeArrivalNavType).mockReturnValue('back')

		render(<ObjectsPage />)

		expect(trackObjectsListArrived).toHaveBeenCalledTimes(1)
		expect(trackObjectsListArrived).toHaveBeenCalledWith({ nav_type: 'back', objectType: null })
	})

	it('fires objects_list_arrived on every mount, including direct (URL-bar) and link (SPA nav) landings', async () => {
		const { consumeArrivalNavType } = await import('@/lib/back-nav-tracker')
		const { trackObjectsListArrived } = await import('@/lib/analytics')

		vi.mocked(consumeArrivalNavType).mockReturnValue('direct')
		const { unmount } = render(<ObjectsPage />)
		expect(trackObjectsListArrived).toHaveBeenCalledTimes(1)
		expect(trackObjectsListArrived).toHaveBeenLastCalledWith({
			nav_type: 'direct',
			objectType: null,
		})
		unmount()

		vi.mocked(consumeArrivalNavType).mockReturnValue('link')
		render(<ObjectsPage />)
		expect(trackObjectsListArrived).toHaveBeenCalledTimes(2)
		expect(trackObjectsListArrived).toHaveBeenLastCalledWith({
			nav_type: 'link',
			objectType: null,
		})
	})
})
