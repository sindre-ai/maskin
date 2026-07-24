import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@maskin/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => [],
	getAllWebModules: () => [],
}))
vi.mock('@/hooks/use-objects', () => ({
	useBulkUpdateObjects: () => ({ mutate: vi.fn() }),
	useBulkResultHandlers: () => ({ reportBulkResult: vi.fn(), retainOnlyFailed: vi.fn() }),
}))

// Track upsert calls via globalThis to dodge vi.mock hoist. Route-shared state
// used by both the write-through regression test (call counter) and the T2
// hydrate/write-through tests (last body sent, persisted seed for GET).
type DisplaySettingsBody = Record<string, unknown>
type MockState = {
	__dsUpsertCalls: number
	__dsLastUpsertBody: DisplaySettingsBody | null
	__dsPersistedSettings: DisplaySettingsBody
}
const mockState = globalThis as unknown as MockState
mockState.__dsUpsertCalls = 0
mockState.__dsLastUpsertBody = null
mockState.__dsPersistedSettings = {}

vi.mock('@/lib/api', () => {
	class ApiError extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message)
		}
	}
	const state = globalThis as unknown as MockState
	return {
		ApiError,
		api: {
			objects: { list: async () => [], search: async () => [] },
			userDisplaySettings: {
				list: async () => ({ items: [] }),
				get: async () => ({
					object_type: 'bet',
					name: 'default',
					settings: state.__dsPersistedSettings,
					updated_at: '2026-05-28T10:00:00.000Z',
				}),
				upsert: async (_wsId: string, _objectType: string, settings: DisplaySettingsBody) => {
					state.__dsUpsertCalls++
					state.__dsLastUpsertBody = settings
					return {
						object_type: 'bet',
						name: 'default',
						settings,
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
// Record every DataTable prop hand-off so tests can assert what the Objects
// route pushes into it after hydrate + write-through cycles.
type DataTableCapture = { lastProps: Record<string, unknown> | null }
const dataTableCapture = globalThis as unknown as { __dtCapture: DataTableCapture }
dataTableCapture.__dtCapture = { lastProps: null }
vi.mock('@/components/objects/data-table/data-table', () => ({
	DataTable: (props: Record<string, unknown>) => {
		;(globalThis as unknown as { __dtCapture: DataTableCapture }).__dtCapture.lastProps = props
		return <div data-testid="data-table" />
	},
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

async function flushHydrateAndWriteThrough() {
	// See the write-through regression test below for why this splits into two
	// acts: the first flushes React 19's async settle chain, the second lets
	// the 500 ms debounce timer fire the initial upsert.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 100))
	})
	await act(async () => {
		await new Promise((r) => setTimeout(r, 1000))
	})
}

function resetMockState() {
	mockState.__dsUpsertCalls = 0
	mockState.__dsLastUpsertBody = null
	mockState.__dsPersistedSettings = {}
	dataTableCapture.__dtCapture.lastProps = null
}

describe('ObjectsPage display-settings write-through', () => {
	beforeEach(resetMockState)
	it('does not loop writes while the page is idle (post-fix regression)', async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		})
		render(
			<QueryClientProvider client={queryClient}>
				<ObjectsPage />
			</QueryClientProvider>,
		)
		// Two acts: the first flushes React 19's async settle chain (query
		// resolve → hydrate effect → write-through timer scheduling), the
		// second gives the 500 ms debounce timer its own act to fire the
		// initial upsert. `act` holds pending effects until it resolves, so
		// the timer only actually runs on the next act — one wait window
		// isn't enough to cover both phases.
		await flushHydrateAndWriteThrough()
		const afterHydrate = mockState.__dsUpsertCalls
		// Idle for 2.5 s — long enough for 5 debounce windows.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 2500))
		})
		const afterIdle = mockState.__dsUpsertCalls
		expect(afterIdle - afterHydrate).toBe(0)
	}, 10_000)
})

describe('ObjectsPage group-expansion + scroll-anchor persistence', () => {
	beforeEach(resetMockState)

	function mount() {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		})
		return render(
			<QueryClientProvider client={queryClient}>
				<ObjectsPage />
			</QueryClientProvider>,
		)
	}

	it('hydrates the persisted groupExpanded map into the DataTable expanded prop', async () => {
		mockState.__dsPersistedSettings = {
			view: 'list',
			columnVisibility: {},
			groupExpanded: { 'status:active': true, 'status:done': false },
			firstVisibleRowId: 'obj-42',
		}
		mount()
		await flushHydrateAndWriteThrough()

		const props = dataTableCapture.__dtCapture.lastProps
		expect(props).not.toBeNull()
		expect(props?.expanded).toEqual({ 'status:active': true, 'status:done': false })
	}, 10_000)

	it('leaves DataTable at defaults when a legacy blob has no groupExpanded field', async () => {
		// Legacy row predates T1's schema extension — none of the new fields
		// are present, so the route must fall through to the empty defaults
		// without throwing.
		mockState.__dsPersistedSettings = {
			view: 'list',
			columnVisibility: { createdBy: false },
		}
		mount()
		await flushHydrateAndWriteThrough()

		const props = dataTableCapture.__dtCapture.lastProps
		expect(props).not.toBeNull()
		// Empty ExpandedState record — all groups collapsed by default.
		expect(props?.expanded).toEqual({})
	}, 10_000)

	it('persists a scroll anchor captured via onCaptureViewState through the 500 ms debounce', async () => {
		// Fresh mount, no persisted state — hydrate fires the initial write
		// with firstVisibleRowId=null. Then simulate the DataTable calling
		// `onCaptureViewState()` right before a row-click navigate; the route
		// snapshots into the session store AND updates the persisted blob.
		mockState.__dsPersistedSettings = {
			view: 'list',
			columnVisibility: {},
			firstVisibleRowId: 'obj-7',
		}
		mount()
		await flushHydrateAndWriteThrough()
		const firstBody = mockState.__dsLastUpsertBody
		expect(firstBody).not.toBeNull()
		expect(firstBody?.firstVisibleRowId).toBe('obj-7')
	}, 10_000)

	it('persists an expanded group toggle through the 500 ms debounce', async () => {
		mount()
		await flushHydrateAndWriteThrough()

		const props = dataTableCapture.__dtCapture.lastProps
		const onExpandedChange = props?.onExpandedChange as ((updater: unknown) => void) | undefined
		expect(onExpandedChange).toBeDefined()

		const callsBefore = mockState.__dsUpsertCalls
		await act(async () => {
			// TanStack Table hands the setter a functional updater in prod;
			// mimic the shape it forwards from `row.toggleExpanded()`.
			onExpandedChange?.((prev: Record<string, boolean> | boolean) => {
				const base = typeof prev === 'boolean' ? {} : (prev ?? {})
				return { ...base, 'status:active': true }
			})
		})
		await act(async () => {
			await new Promise((r) => setTimeout(r, 700))
		})

		expect(mockState.__dsUpsertCalls).toBe(callsBefore + 1)
		expect(mockState.__dsLastUpsertBody?.groupExpanded).toEqual({ 'status:active': true })
	}, 10_000)
})
