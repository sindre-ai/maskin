import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

// Guards the per-actor display-settings write-through against the
// "useMutation in effect deps" anti-pattern. React Query's mutation
// object identity changes on every render, so depending on it in an
// effect causes the debounce to re-arm forever after the first write —
// producing one write per ~500 ms while the page is open. Keep this
// test honest by using the real `useMutation` hook with a mocked API
// surface.
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useSearch: () => ({
			type: 'bet',
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
vi.mock('@maskin/module-sdk', () => ({ getEnabledObjectTypeTabs: () => [] }))
vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: vi.fn() }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))

// Track upsert calls via globalThis to dodge vi.mock hoist.
;(globalThis as unknown as { __dsUpsertCalls?: number }).__dsUpsertCalls = 0

vi.mock('@/lib/api', () => {
	class ApiError extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message)
		}
	}
	return {
		ApiError,
		api: {
			objects: { list: async () => [], search: async () => [] },
			userDisplaySettings: {
				list: async () => ({ items: [] }),
				get: async () => ({
					object_type: 'bet',
					name: 'default',
					settings: {},
					updated_at: '2026-05-28T10:00:00.000Z',
				}),
				upsert: async () => {
					;(globalThis as unknown as { __dsUpsertCalls: number }).__dsUpsertCalls++
					return {
						object_type: 'bet',
						name: 'default',
						settings: {
							view: 'list' as const,
							sort: 'createdAt',
							order: 'desc' as const,
							groupBy: null,
							columnVisibility: { createdBy: false },
						},
						updated_at: '2026-05-28T10:00:00.000Z',
					}
				},
			},
		},
	}
})

vi.mock('@/components/objects/bulk-action-bar', () => ({ BulkActionBar: () => null }))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/objects/data-table/data-table', () => ({
	DataTable: () => <div data-testid="data-table" />,
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

import { Route } from '@/routes/_authed/$workspaceId/objects/index'

const RouteOptions = Route as unknown as { component: React.FC }
const ObjectsPage = RouteOptions.component

describe('ObjectsPage display-settings write-through', () => {
	it('does not loop writes while the page is idle (post-fix regression)', async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		})
		;(globalThis as unknown as { __dsUpsertCalls: number }).__dsUpsertCalls = 0
		render(
			<QueryClientProvider client={queryClient}>
				<ObjectsPage />
			</QueryClientProvider>,
		)
		// Let the persisted-settings query resolve and the debounce window pass.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 750))
		})
		const afterHydrate = (globalThis as unknown as { __dsUpsertCalls: number }).__dsUpsertCalls
		// Idle for 2.5 s — long enough for 5 debounce windows.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 2500))
		})
		const afterIdle = (globalThis as unknown as { __dsUpsertCalls: number }).__dsUpsertCalls
		expect(afterIdle - afterHydrate).toBe(0)
	}, 10_000)
})
