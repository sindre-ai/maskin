import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => ({
			type: undefined,
			status: undefined,
			owner: undefined,
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
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-query')>()
	return {
		...actual,
		useInfiniteQuery: () => ({
			data: { pages: [[]] },
			hasNextPage: false,
			isFetchingNextPage: false,
			isError: false,
			fetchNextPage: vi.fn(),
			isLoading: false,
		}),
	}
})

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/objects/data-table/data-table', () => ({
	DataTable: () => <div data-testid="data-table" />,
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

vi.mock('@/hooks/use-objects', () => ({
	useUpdateObject: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/lib/api', () => ({
	api: { objects: { list: vi.fn(), search: vi.fn() } },
}))

vi.mock('@/lib/query-keys', () => ({
	queryKeys: {
		objects: { listInfinite: () => ['objects'] },
		imports: { detail: (id: string) => ['imports', 'detail', id] },
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
			owner: undefined,
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
			owner: 'actor-1',
			sort: 'title',
			order: 'asc',
			q: 'search term',
			groupBy: 'status',
		})
		expect(result).toEqual({
			type: 'bet',
			status: 'active',
			owner: 'actor-1',
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
})

describe('ObjectsPage', () => {
	it('renders page header and data table', () => {
		render(<ObjectsPage />)
		expect(screen.getByText('Objects')).toBeInTheDocument()
		expect(screen.getByTestId('data-table')).toBeInTheDocument()
		expect(screen.getByTestId('data-table-toolbar')).toBeInTheDocument()
	})
})
