import { ImportDialog } from '@/components/imports/import-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { BoardView } from '@/components/objects/board/board-view'
import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { type ObjectsTableMeta, getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { ColumnInfo } from '@/components/objects/data-table/data-table-controls'
import { DataTableToolbar } from '@/components/objects/data-table/data-table-toolbar'
import type { DisplayPanelView } from '@/components/objects/data-table/display-panel'
import { getDynamicColumns } from '@/components/objects/data-table/dynamic-columns'
import type { FieldDefinition } from '@/components/objects/field-value-input'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { FilterChip } from '@/components/shared/filter-chip'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useImportToast } from '@/hooks/use-imports'
import { useBulkResultHandlers, useBulkUpdateObjects } from '@/hooks/use-objects'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { trackEvent, trackObjectsListArrived, trackObjectsListGroupToggled } from '@/lib/analytics'
import { api } from '@/lib/api'
import type { DisplaySettingsBody, ObjectResponse } from '@/lib/api'
import { consumeArrivalNavType } from '@/lib/back-nav-tracker'
import { type BetStatusResult, buildBetStatuses } from '@/lib/bet-status'
import { fetchAllPages } from '@/lib/pagination'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { getAllWebModules, getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { ALL_TYPES_KEY, SAFE_METADATA_FIELD_NAME_RE } from '@maskin/shared'
import {
	type InfiniteData,
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from '@tanstack/react-query'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import type { GroupingState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { Filter, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/objects/')({
	component: ObjectsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => {
		// Pass through dynamic `metadata.<field>` filter keys so they persist in
		// the URL and survive `updateSearch()` merges. Fixed keys are plucked
		// explicitly below; unlisted keys would otherwise be dropped.
		// Number/boolean metadata fields (e.g. a bare `metadata.priority=5` or
		// `metadata.active=true` from a hand-typed or externally-built URL) parse
		// to a JS number/boolean here — coerce back to string rather than
		// dropping them, since the filter value is always compared as text.
		const metadataFilters: Record<string, string> = {}
		for (const [key, value] of Object.entries(search)) {
			if (!key.startsWith('metadata.')) continue
			if (!SAFE_METADATA_FIELD_NAME_RE.test(key.slice('metadata.'.length))) continue
			if (typeof value === 'string') metadataFilters[key] = value
			else if (typeof value === 'number' || typeof value === 'boolean') {
				metadataFilters[key] = String(value)
			}
		}
		// Include-archived is URL-only per T5. Present as `1` when on; omitted
		// otherwise so the default excludes archived rows via T3's API gate.
		// Deep-links, back/forward, and hard-refresh preserve the choice —
		// per-view persistence intentionally does not touch localStorage.
		const rawIncludeArchived = search.includeArchived
		const includeArchived =
			rawIncludeArchived === '1' ||
			rawIncludeArchived === 1 ||
			rawIncludeArchived === true ||
			rawIncludeArchived === 'true'
		return {
			type: typeof search.type === 'string' ? search.type : undefined,
			status: typeof search.status === 'string' ? search.status : undefined,
			driver: typeof search.driver === 'string' ? search.driver : undefined,
			sort: typeof search.sort === 'string' ? search.sort : 'createdAt',
			order:
				typeof search.order === 'string' && ['asc', 'desc'].includes(search.order)
					? (search.order as 'asc' | 'desc')
					: 'desc',
			q: typeof search.q === 'string' ? search.q : undefined,
			groupBy: typeof search.groupBy === 'string' ? search.groupBy : undefined,
			ids: typeof search.ids === 'string' ? search.ids : undefined,
			includeArchived: includeArchived ? (1 as const) : undefined,
			...metadataFilters,
		}
	},
})

const PAGE_SIZE = 50
const BOARD_PAGE_SIZE = 20
const BOARD_MANUAL_SORT = 'boardOrder'

function ObjectsPage() {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const searchParams = useSearch({ from: '/_authed/$workspaceId/objects/' })
	const {
		type: typeFilter,
		status: statusFilter,
		driver: driverFilter,
		sort,
		order,
		q,
		groupBy,
		ids: idsFilter,
		includeArchived: includeArchivedParam,
	} = searchParams
	const includeArchived = includeArchivedParam === 1
	// Per the task scope, the "Show" section (with the Include archived toggle)
	// is bet-only for now — surfaced when the bet tab is active. Non-bet tabs
	// keep the existing panel shape until archive lands for their type.
	const supportsIncludeArchived = typeFilter === 'bet'

	const [importOpen, setImportOpen] = useState(false)
	const [createPickerOpen, setCreatePickerOpen] = useState(false)
	const { startTracking: trackImport } = useImportToast(workspaceId)
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
		createdBy: false,
	})
	// View switcher (List | Board). Route-local — persists per object type
	// through the same Display settings row, never via the URL.
	const [view, setView] = useState<DisplayPanelView>('list')

	// Row selection keys are object IDs (data-table sets getRowId: row => row.id),
	// so we can lift them directly as the selection surface for sibling bulk-action UI.
	const selectedIds = useMemo(() => Object.keys(rowSelection), [rowSelection])
	const clearSelection = useCallback(() => setRowSelection({}), [])
	const handleObjectSelectionChange = useCallback((id: string, selected: boolean) => {
		setRowSelection((current) => {
			const next = { ...current }
			if (selected) next[id] = true
			else delete next[id]
			return next
		})
	}, [])
	const handleObjectRangeSelectionChange = useCallback((ids: string[]) => {
		setRowSelection((current) => {
			const next = { ...current }
			for (const id of ids) next[id] = true
			return next
		})
	}, [])
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection whenever the active workspace changes
	useEffect(() => {
		setRowSelection({})
	}, [workspaceId])

	// Fires on every mount, with the nav_type resolved from popstate + the
	// initial PerformanceNavigationTiming entry. The ship-metric denominator
	// filters to `nav_type='back'` in PostHog; the `direct` / `link` variants
	// ride along so the arrival stream can be sliced by nav type later. The
	// tracker is initialised at app boot (see main.tsx) so deep-link starts
	// followed by a browser-back to the list are captured too. typeFilter is
	// intentionally excluded from deps — a tab switch changes it under a
	// stable mount and must not re-emit the arrival event.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once event
	useEffect(() => {
		trackObjectsListArrived({
			nav_type: consumeArrivalNavType(),
			objectType: typeFilter ?? null,
		})
	}, [])

	// User-initiated group toggle is the bet's numerator. Fires unconditionally
	// on every user toggle — the 30s pairing against `objects_list_arrived` is
	// enforced by the PostHog query, not the client. The `source: 'system'`
	// variant is reserved for the eventual T2 restore path so wire-verification
	// can tell a user rebuild apart from the silent restore.
	const handleGroupToggle = useCallback(
		(expanded: boolean) => {
			trackObjectsListGroupToggled({
				source: 'user',
				expanded,
				objectType: typeFilter ?? null,
			})
		},
		[typeFilter],
	)

	// Linear-style `C` shortcut opens the create picker with the active type
	// tab pre-selected. Guarded so typing into filters/search never triggers it.
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	const searchParamsRef = useRef(searchParams)
	searchParamsRef.current = searchParams

	const { data: actors } = useActors(workspaceId)
	const enabledModules = useEnabledModules()
	const customExtensions = useCustomExtensions()
	const settings = workspace.settings as Record<string, unknown>

	// Build tabs
	const tabs = useMemo(() => {
		const moduleTabs = getEnabledObjectTypeTabs(enabledModules)
		const customTabs = customExtensions.filter((ext) => ext.enabled).flatMap((ext) => ext.tabs)
		return [
			{ label: 'All', value: undefined as string | undefined },
			...moduleTabs.map((t) => ({ label: t.label, value: t.value as string | undefined })),
			...customTabs.map((t) => ({ label: t.label, value: t.value as string | undefined })),
		]
	}, [enabledModules, customExtensions])

	// `searchParams` is a fresh object every render (TanStack Router doesn't
	// give it referential stability here — every other filter in this file
	// destructures a primitive off it for that reason). Serialize the active
	// `metadata.*` entries into a stable string first, then derive the object
	// from that string, so `metadataFilters` only gets a new reference when
	// the actual filter content changes — anything else re-fires effects
	// (write-through, urlIsInDefaultShape) on every render, looping writes.
	const metadataFiltersKey = useMemo(() => {
		return Object.entries(searchParams)
			.filter(([key, value]) => key.startsWith('metadata.') && typeof value === 'string' && value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
			.join('&')
	}, [searchParams])

	// Active metadata filters, keyed by field name (URL key `metadata.<field>`
	// with the prefix stripped). Drives the Display-panel rows and the API params.
	const metadataFilters = useMemo(() => {
		const m: Record<string, string> = {}
		if (!metadataFiltersKey) return m
		for (const pair of metadataFiltersKey.split('&')) {
			const eqIdx = pair.indexOf('=')
			const key = pair.slice(0, eqIdx)
			m[key.slice('metadata.'.length)] = decodeURIComponent(pair.slice(eqIdx + 1))
		}
		return m
	}, [metadataFiltersKey])

	// Build API filters
	const filters = useMemo(() => {
		const f: Record<string, string> = {}
		if (typeFilter) f.type = typeFilter
		if (statusFilter) f.status = statusFilter
		if (driverFilter) f.driver = driverFilter
		if (idsFilter) f.ids = idsFilter
		for (const [field, value] of Object.entries(metadataFilters)) {
			f[`metadata.${field}`] = value
		}
		f.sort = sort
		f.order = order
		// Opt-in only: pass through when the "Include archived" toggle is on.
		// Omitting the flag lets T3's route default (hide archived) apply.
		if (supportsIncludeArchived && includeArchived) f.include_archived = 'true'
		return f
	}, [
		typeFilter,
		statusFilter,
		driverFilter,
		idsFilter,
		sort,
		order,
		metadataFilters,
		supportsIncludeArchived,
		includeArchived,
	])

	// Infinite query — use search endpoint when q is present
	const infiniteQuery = useInfiniteQuery({
		queryKey: queryKeys.objects.listInfinite(workspaceId, { ...filters, q }),
		queryFn: ({ pageParam }) => {
			const params: Record<string, string> = {
				...filters,
				limit: String(PAGE_SIZE),
				offset: String(pageParam),
			}
			if (q) {
				params.q = q
				return api.objects.search(workspaceId, params)
			}
			return api.objects.list(workspaceId, params)
		},
		getNextPageParam: (lastPage, allPages) => {
			if (lastPage.length < PAGE_SIZE) return undefined
			return allPages.flat().length
		},
		initialPageParam: 0,
		placeholderData: keepPreviousData,
	})

	const allObjects = useMemo(() => infiniteQuery.data?.pages.flat() ?? [], [infiniteQuery.data])

	// Derive available statuses grouped by type (scoped to enabled types only)
	const statusesByType = useMemo(() => {
		const statusMap = settings?.statuses as Record<string, string[]> | undefined
		if (!statusMap) return {}
		if (typeFilter) return { [typeFilter]: statusMap[typeFilter] ?? [] }
		const enabledTypes = new Set(tabs.map((t) => t.value).filter(Boolean))
		return Object.fromEntries(Object.entries(statusMap).filter(([type]) => enabledTypes.has(type)))
	}, [settings, typeFilter, tabs])

	// Board view needs a single active object type with at least one configured
	// status, so List is the only option on the All tab.
	const boardSupported = Boolean(typeFilter && (statusesByType[typeFilter]?.length ?? 0) > 0)
	// Effective view: even if the user previously chose Board for this type, an
	// unsupported context (All tab, type with zero configured statuses) renders
	// List. We never write that fallback back to settings — the stored
	// preference is preserved for when the type becomes board-capable again.
	const effectiveView: DisplayPanelView = boardSupported ? view : 'list'

	const boardParams = useMemo(() => {
		if (!typeFilter) return null
		const params: Record<string, string> = {
			...filters,
			type: typeFilter,
			sort,
			order,
			limit: String(BOARD_PAGE_SIZE),
			offset: '0',
		}
		if (q) params.q = q
		if (groupBy) params.groupBy = groupBy
		return params
	}, [filters, groupBy, order, q, sort, typeFilter])

	const boardQuery = useQuery({
		queryKey: queryKeys.objects.board(workspaceId, boardParams ?? {}),
		queryFn: () => api.objects.board(workspaceId, boardParams as Record<string, string>),
		enabled: effectiveView === 'board' && !!boardParams,
		placeholderData: keepPreviousData,
	})

	const boardInitialObjects = useMemo(
		() => boardQuery.data?.columns.flatMap((column) => column.objects) ?? [],
		[boardQuery.data],
	)
	const visibleObjects = effectiveView === 'board' ? boardInitialObjects : allObjects

	// Field definitions for dynamic columns. Layer enabled-module defaults under
	// workspace overrides so extension-provided types (e.g. knowledge) ship with
	// their column set even when the workspace hasn't customised field_definitions.
	const fieldDefinitions = useMemo(() => {
		const workspaceFields = settings?.field_definitions as
			| Record<string, FieldDefinition[]>
			| undefined
		const merged: Record<string, FieldDefinition[]> = {}
		for (const mod of getAllWebModules()) {
			if (!enabledModules.includes(mod.id)) continue
			const modFields = mod.defaultSettings?.field_definitions
			if (!modFields) continue
			for (const [type, fields] of Object.entries(modFields)) {
				merged[type] = fields
			}
		}
		if (workspaceFields) {
			for (const [type, fields] of Object.entries(workspaceFields)) {
				merged[type] = fields
			}
		}
		return Object.keys(merged).length > 0 ? merged : undefined
	}, [settings, enabledModules])

	// Metadata filter rows only apply when a single object type is selected — the
	// field definitions (and thus the filterable fields) are per-type. On the
	// "All" tab this is undefined so the Display panel renders no metadata rows.
	const typeFieldDefinitions = typeFilter ? (fieldDefinitions?.[typeFilter] ?? []) : undefined

	// Update search params helper — uses ref to stay stable across param changes
	const updateSearch = useCallback(
		(updates: Record<string, string | number | undefined>) => {
			const next: Record<string, unknown> = { ...searchParamsRef.current, ...updates }
			for (const key of Object.keys(next)) {
				if (next[key] === undefined || next[key] === '') delete next[key]
			}
			navigate({
				to: '/$workspaceId/objects',
				params: { workspaceId },
				search: next as typeof searchParams,
				replace: true,
			})
		},
		[navigate, workspaceId],
	)

	// Sort handler for column headers
	const handleSort = useCallback(
		(columnId: string) => {
			if (sort === columnId) {
				updateSearch({ order: order === 'asc' ? 'desc' : 'asc' })
			} else {
				updateSearch({ sort: columnId, order: 'desc' })
			}
		},
		[sort, order, updateSearch],
	)

	// Bet status indicator wiring — the Title cell renders `IndicatorBadgeRow`
	// beside each bet's title. It classifies over child tasks; the overview
	// only loads a flat page of objects, so pull the workspace's full task
	// list and `breaks_into` relationships once and group them here. Both
	// queries page through the endpoints (`limit=50` default would silently
	// misclassify any bet whose child tasks fell into the second page as
	// `idle`) and are gated on whether any bets are actually visible so tabs
	// like `insight` never pay for tasks + rels they don't render.
	const hasVisibleBets = useMemo(
		() => visibleObjects.some((o) => o.type === 'bet'),
		[visibleObjects],
	)
	const { data: workspaceTasks } = useQuery({
		queryKey: queryKeys.objects.list(workspaceId, { type: 'task' }),
		queryFn: () =>
			fetchAllPages<ObjectResponse>(({ limit, offset }) =>
				api.objects.list(workspaceId, {
					type: 'task',
					limit: String(limit),
					offset: String(offset),
				}),
			),
		enabled: hasVisibleBets,
	})
	const { data: breaksIntoRels } = useQuery({
		queryKey: [...queryKeys.relationships.all(workspaceId), { type: 'breaks_into' }] as const,
		queryFn: () =>
			fetchAllPages(({ limit, offset }) =>
				api.relationships.list(workspaceId, {
					type: 'breaks_into',
					limit: String(limit),
					offset: String(offset),
				}),
			),
		enabled: hasVisibleBets,
	})
	const betStatuses = useMemo<Map<string, BetStatusResult>>(() => {
		if (!hasVisibleBets || !workspaceTasks || !breaksIntoRels) return new Map()
		const bets = visibleObjects.filter((o) => o.type === 'bet')
		return buildBetStatuses(bets, workspaceTasks, breaksIntoRels, new Date())
	}, [hasVisibleBets, workspaceTasks, breaksIntoRels, visibleObjects])

	// Bet status is rendered inside the Title cell (not as its own column), so
	// its show/hide toggle lives in the same `columnVisibility` map as the real
	// columns and is threaded into the cell via `showBetStatusIndicator`.
	const showBetStatusIndicator = columnVisibility.betStatusIndicator !== false

	// Table meta — sort state passed via meta to avoid re-creating columns on every sort change
	const tableMeta: ObjectsTableMeta = useMemo(
		() => ({
			onSort: handleSort,
			currentSort: sort,
			currentOrder: order,
			betStatuses,
			showBetStatusIndicator,
		}),
		[handleSort, sort, order, betStatuses, showBetStatusIndicator],
	)

	// Columns — stable across sort changes since sort state is in meta
	const columns = useMemo(
		() => [
			...getStaticColumns({
				workspaceId,
				actors,
			}),
			...getDynamicColumns(fieldDefinitions, typeFilter),
		],
		[workspaceId, actors, fieldDefinitions, typeFilter],
	)

	// Column info for the controls popover
	const columnInfo: ColumnInfo[] = useMemo(() => {
		const staticNames: Record<string, string> = {
			status: 'Status',
			type: 'Type',
			driver: 'Driver',
			createdBy: 'Created by',
			createdAt: 'Created',
			updatedAt: 'Updated',
		}
		const base = columns
			.filter((col) => {
				const id = 'accessorKey' in col ? String(col.accessorKey) : col.id
				return id !== 'select'
			})
			.map((col) => {
				const id = 'accessorKey' in col ? String(col.accessorKey) : (col.id ?? '')
				const canHide = col.enableHiding !== false && id !== 'title'
				const label = id.startsWith('metadata.')
					? id.slice(9).replace(/_/g, ' ')
					: (staticNames[id] ?? id)
				return { id, label, canHide }
			})
		// Synthetic entry: bet status lives inside the Title cell, so it has no
		// column of its own. Only surface the toggle on tabs where bets can appear
		// — hiding it on `insight` / `task` tabs where it would do nothing.
		if (!typeFilter || typeFilter === 'bet') {
			base.push({ id: 'betStatusIndicator', label: 'Bet status', canHide: true })
		}
		return base
	}, [columns, typeFilter])

	// Grouping state
	const groupingState: GroupingState = groupBy ? [groupBy] : []

	// Hide dynamic columns by default when in "All" tab
	const effectiveVisibility = useMemo(() => {
		const vis = { ...columnVisibility }
		if (!typeFilter && fieldDefinitions) {
			const allFields = Object.values(fieldDefinitions).flat()
			for (const field of allFields) {
				const colId = `metadata.${field.name}`
				if (!(colId in vis)) {
					vis[colId] = false
				}
			}
		}
		return vis
	}, [columnVisibility, typeFilter, fieldDefinitions])

	const handleColumnVisibilityChange = useCallback((columnId: string, visible: boolean) => {
		setColumnVisibility((prev) => ({ ...prev, [columnId]: visible }))
	}, [])

	// Per-actor display settings (persistence layer from Task 5).
	// Hydration policy: when the user lands on a tab with persisted settings
	// and the URL is in its default shape, apply the saved view. Once any
	// tracked field changes we write the whole blob back. The All tab uses
	// the `__all__` sentinel slot so its column-visibility toggles persist
	// the same way per-type tabs do — without that, the user's choices in
	// the display menu reset to defaults on every navigation away and back.
	const displaySettingsKey = typeFilter ?? ALL_TYPES_KEY
	const displaySettingsQuery = useUserDisplaySettings(workspaceId, displaySettingsKey)
	const updateDisplaySettings = useUpdateUserDisplaySettings(workspaceId)
	// `useMutation` returns a new object reference on every render, but the
	// `mutate` function itself is stable. Pinning the stable callable into a
	// ref keeps the write-through effect's deps from changing on every render
	// — without that, the effect would re-arm its 500 ms timeout indefinitely
	// after the first write, producing a write-every-500 ms loop while the
	// page is open.
	const updateMutateRef = useRef(updateDisplaySettings.mutate)
	updateMutateRef.current = updateDisplaySettings.mutate
	const hydratedTypesRef = useRef<Set<string>>(new Set())

	const urlIsInDefaultShape = useMemo(
		() =>
			(!searchParams.sort || searchParams.sort === 'createdAt') &&
			(!searchParams.order || searchParams.order === 'desc') &&
			!searchParams.groupBy &&
			!searchParams.status &&
			!searchParams.driver &&
			Object.keys(metadataFilters).length === 0,
		[
			searchParams.sort,
			searchParams.order,
			searchParams.groupBy,
			searchParams.status,
			searchParams.driver,
			metadataFilters,
		],
	)

	useEffect(() => {
		if (hydratedTypesRef.current.has(displaySettingsKey)) return
		if (!displaySettingsQuery.isSuccess) return
		// Mark hydrated even if there are no persisted settings yet — that lets
		// the write-through effect start tracking once the user makes their
		// first change, without re-running this hydrate block.
		hydratedTypesRef.current.add(displaySettingsKey)
		const persisted = displaySettingsQuery.data
		if (!persisted) {
			// No saved view for this key — fall back to the route default.
			setView('list')
			return
		}
		const s = persisted.settings
		// View hydrates regardless of urlIsInDefaultShape: `view` is route-local
		// (not in the URL), so the URL's shape can't conflict with it.
		setView(s.view ?? 'list')
		if (urlIsInDefaultShape) {
			const updates: Record<string, string | undefined> = {}
			if (s.sort) updates.sort = s.sort
			if (s.order) updates.order = s.order
			if (s.groupBy) updates.groupBy = s.groupBy
			if (s.filters?.status) updates.status = s.filters.status
			if (s.filters?.driver) updates.driver = s.filters.driver
			for (const [field, value] of Object.entries(s.filters?.metadata ?? {})) {
				updates[`metadata.${field}`] = value
			}
			if (Object.keys(updates).length > 0) updateSearch(updates)
		}
		// Persisted blob wins: the saved map REPLACES the route's initial
		// columnVisibility defaults (e.g. `{ createdBy: false }`). The user's
		// last toggle is canonical — never merge old defaults back on top.
		// This applies on the All tab too — `__all__` is its own row, so
		// switching between All and a type tab restores each side's own state.
		if (s.columnVisibility) setColumnVisibility(s.columnVisibility)
	}, [
		displaySettingsKey,
		displaySettingsQuery.isSuccess,
		displaySettingsQuery.data,
		urlIsInDefaultShape,
		updateSearch,
	])

	// Write-through. Only fires after this key has been hydrated so the
	// initial apply doesn't immediately re-write the same blob back.
	useEffect(() => {
		if (!hydratedTypesRef.current.has(displaySettingsKey)) return
		const settings: DisplaySettingsBody = {
			view,
			sort,
			order,
			groupBy: groupBy ?? null,
			columnVisibility,
		}
		const filters: { status?: string; driver?: string; metadata?: Record<string, string> } = {}
		if (statusFilter) filters.status = statusFilter
		if (driverFilter) filters.driver = driverFilter
		if (Object.keys(metadataFilters).length > 0) filters.metadata = metadataFilters
		if (filters.status || filters.driver || filters.metadata) settings.filters = filters

		const handle = setTimeout(() => {
			updateMutateRef.current({ objectType: displaySettingsKey, settings })
		}, 500)
		return () => clearTimeout(handle)
	}, [
		displaySettingsKey,
		view,
		sort,
		order,
		groupBy,
		statusFilter,
		driverFilter,
		metadataFilters,
		columnVisibility,
	])

	const idsCount = idsFilter ? idsFilter.split(',').length : 0

	const clearIdsFilter = useCallback(() => {
		updateSearch({ ids: undefined })
	}, [updateSearch])

	// Human-readable labels for the active status/driver chips. Mirror the
	// DisplayPanel picker's collapsing rule: single value → the value, >1 →
	// "{N} statuses/drivers". Keeps the chip strip readable at any selection
	// size without spilling the toolbar row.
	const activeStatuses = useMemo(
		() => (statusFilter ? statusFilter.split(',').filter(Boolean) : []),
		[statusFilter],
	)
	const activeDrivers = useMemo(
		() => (driverFilter ? driverFilter.split(',').filter(Boolean) : []),
		[driverFilter],
	)
	const statusChipValue =
		activeStatuses.length === 1
			? (activeStatuses[0]?.replace(/_/g, ' ') ?? '')
			: `${activeStatuses.length} statuses`
	const driverChipValue =
		activeDrivers.length === 1
			? (actors?.find((a) => a.id === activeDrivers[0])?.name ?? '1 driver')
			: `${activeDrivers.length} drivers`
	// Include-archived is the third chip source. Bet-only per T5 — non-bet tabs
	// never see the toggle or the chip. `supportsIncludeArchived` already gates
	// the toggle in DisplayPanel; mirroring it here keeps the chip in lockstep
	// so a leftover URL param on a non-bet tab doesn't render an orphan chip.
	const archivedChipActive = supportsIncludeArchived && includeArchived
	const hasChipFilters = activeStatuses.length > 0 || activeDrivers.length > 0 || archivedChipActive

	const bulkOwnerOptions = useMemo(
		() => (actors ?? []).map((a) => ({ id: a.id, name: a.name })),
		[actors],
	)

	const bulkUpdate = useBulkUpdateObjects(workspaceId)
	const queryClient = useQueryClient()

	// Matches the handleBulkDelete pattern: on partial success, prune selection
	// to the ids that still need attention so the bulk bar stays pinned to the
	// failed rows and the operator can retry them without re-selecting.
	const { reportBulkResult, retainOnlyFailed } = useBulkResultHandlers(
		clearSelection,
		setRowSelection,
	)

	const handleBulkStatusChange = useCallback(
		(status: string) => {
			if (selectedIds.length === 0) return
			const ids = [...selectedIds]
			bulkUpdate.mutate(
				{ ids, patch: { status } },
				{
					onSuccess: (data) => {
						retainOnlyFailed(data)
						reportBulkResult(data, ids.length, 'updated')
					},
					onError: () => toast.error('Failed to update objects'),
				},
			)
		},
		[selectedIds, bulkUpdate, reportBulkResult, retainOnlyFailed],
	)

	const handleBulkOwnerChange = useCallback(
		(ownerId: string) => {
			if (selectedIds.length === 0) return
			const ids = [...selectedIds]
			bulkUpdate.mutate(
				{ ids, patch: { driver: ownerId } },
				{
					onSuccess: (data) => {
						retainOnlyFailed(data)
						reportBulkResult(data, ids.length, 'updated')
					},
					onError: () => toast.error('Failed to update objects'),
				},
			)
		},
		[selectedIds, bulkUpdate, reportBulkResult, retainOnlyFailed],
	)

	// Build the path the app uses for object detail pages — kept relative so we can
	// resolve to an absolute URL for clipboard payloads but pass the path directly
	// to window.open for new-tab navigation.
	const objectPath = useCallback((id: string) => `/${workspaceId}/objects/${id}`, [workspaceId])

	// Selected objects we have loaded data for. Titles aren't available for rows
	// outside the current pages, so copy-title actions warn when any selected id
	// hasn't been fetched yet.
	const selectedObjectsLoaded = useMemo(() => {
		if (selectedIds.length === 0) return []
		const idSet = new Set(selectedIds)
		return visibleObjects.filter((o) => idSet.has(o.id))
	}, [selectedIds, visibleObjects])

	// Status options for the bulk action bar — scoped to the selected objects' type.
	// When the selection spans multiple types (or any selected row isn't loaded so we
	// can't verify its type), return [] so the BulkActionBar hides the status control.
	const bulkStatusOptions = useMemo(() => {
		if (selectedIds.length === 0) return []
		if (selectedObjectsLoaded.length !== selectedIds.length) return []
		const types = new Set(selectedObjectsLoaded.map((o) => o.type))
		if (types.size !== 1) return []
		const [type] = types
		const statuses = statusesByType[type as string] ?? []
		return statuses.map((s) => ({ value: s, label: s }))
	}, [selectedIds, selectedObjectsLoaded, statusesByType])

	const handleCopyLinks = useCallback(async () => {
		if (selectedIds.length === 0) return
		const text = selectedIds.map((id) => `${window.location.origin}${objectPath(id)}`).join('\n')
		try {
			await navigator.clipboard.writeText(text)
			toast.success(`Copied ${selectedIds.length} link${selectedIds.length === 1 ? '' : 's'}`)
		} catch {
			toast.error('Failed to copy to clipboard')
		}
	}, [selectedIds, objectPath])

	const handleCopyTitles = useCallback(async () => {
		if (selectedObjectsLoaded.length === 0) return
		const text = selectedObjectsLoaded.map((o) => o.title?.trim() || '(untitled)').join('\n')
		try {
			await navigator.clipboard.writeText(text)
			const n = selectedObjectsLoaded.length
			const missing = selectedIds.length - n
			toast.success(`Copied ${n} title${n === 1 ? '' : 's'}`, {
				description:
					missing > 0 ? `${missing} not loaded yet — scroll to load them first.` : undefined,
			})
		} catch {
			toast.error('Failed to copy to clipboard')
		}
	}, [selectedObjectsLoaded, selectedIds.length])

	const handleCopyTitlesAsLinks = useCallback(async () => {
		if (selectedObjectsLoaded.length === 0) return
		const text = selectedObjectsLoaded
			.map((o) => {
				const title = o.title?.trim() || '(untitled)'
				return `[${title}](${window.location.origin}${objectPath(o.id)})`
			})
			.join('\n')
		try {
			await navigator.clipboard.writeText(text)
			const n = selectedObjectsLoaded.length
			const missing = selectedIds.length - n
			toast.success(`Copied ${n} link${n === 1 ? '' : 's'} as Markdown`, {
				description:
					missing > 0 ? `${missing} not loaded yet — scroll to load them first.` : undefined,
			})
		} catch {
			toast.error('Failed to copy to clipboard')
		}
	}, [selectedObjectsLoaded, selectedIds.length, objectPath])

	const handleOpenLinks = useCallback(() => {
		for (const id of selectedIds) {
			window.open(objectPath(id), '_blank', 'noopener,noreferrer')
		}
	}, [selectedIds, objectPath])

	// No bulk-delete endpoint yet — loop through the existing single-object DELETE
	// so the UX (partial-failure toast + selection-clear on full success) matches
	// the bulk-update path. See tech-debt insight: add /api/objects/bulk-delete.
	const handleBulkDelete = useCallback(async () => {
		if (selectedIds.length === 0) return
		const ids = [...selectedIds]
		const idSet = new Set(ids)

		// Optimistically drop the rows from list caches so the table updates
		// immediately. The invalidate at the end reconciles with the server, so any
		// row whose DELETE failed will reappear on the refetch.
		const listEntries = queryClient.getQueriesData<ObjectResponse[]>({
			queryKey: queryKeys.objects.listPrefix(workspaceId),
		})
		for (const [key, cache] of listEntries) {
			if (!cache) continue
			queryClient.setQueryData<ObjectResponse[]>(
				key,
				cache.filter((o) => !idSet.has(o.id)),
			)
		}
		const infiniteEntries = queryClient.getQueriesData<InfiniteData<ObjectResponse[]>>({
			queryKey: queryKeys.objects.listInfinitePrefix(workspaceId),
		})
		for (const [key, cache] of infiniteEntries) {
			if (!cache) continue
			queryClient.setQueryData<InfiniteData<ObjectResponse[]>>(key, {
				...cache,
				pages: cache.pages.map((page) => page.filter((o) => !idSet.has(o.id))),
			})
		}
		for (const id of ids) {
			queryClient.removeQueries({ queryKey: queryKeys.objects.detail(id) })
		}

		const settled = await Promise.allSettled(ids.map((id) => api.objects.delete(id)))
		const results = settled.map((r, i) => ({
			id: ids[i] as string,
			ok: r.status === 'fulfilled' && r.value.deleted,
			error: r.status === 'rejected' ? String(r.reason) : undefined,
		}))
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })

		// Keep selection only for ids whose DELETE failed, so the bar stays pinned
		// to the rows that still need attention. reportBulkResult clears selection
		// on full success; on partial failure we want the failed ids to remain
		// selected (and the deleted ones removed so their stale ids don't linger).
		const failedIds = new Set(results.filter((r) => !r.ok).map((r) => r.id))
		setRowSelection((prev) => {
			const next: RowSelectionState = {}
			for (const id of Object.keys(prev)) {
				if (failedIds.has(id) || !idSet.has(id)) next[id] = prev[id] as boolean
			}
			return next
		})

		reportBulkResult({ results }, ids.length, 'deleted')
	}, [selectedIds, queryClient, workspaceId, reportBulkResult])

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<PageHeader title="Objects" />

			{idsFilter && (
				<div className="flex items-center gap-2 mx-6 mb-3 px-3 py-2 rounded-md bg-muted/50 border text-sm">
					<Filter className="h-4 w-4 text-muted-foreground shrink-0" />
					<span className="text-muted-foreground">
						Showing{' '}
						<Badge variant="secondary" className="mx-0.5">
							{idsCount}
						</Badge>{' '}
						{idsCount === 1 ? 'object' : 'objects'} from notification
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="ml-auto h-6 px-2 text-muted-foreground hover:text-foreground"
						onClick={clearIdsFilter}
					>
						<X className="h-3 w-3 mr-1" />
						Clear filter
					</Button>
				</div>
			)}

			<DataTableToolbar
				columns={columnInfo}
				columnVisibility={effectiveVisibility}
				onColumnVisibilityChange={handleColumnVisibilityChange}
				tabs={tabs}
				typeFilter={typeFilter}
				onTypeFilterChange={(value) => {
					// Clear the outgoing key (real type or `__all__`) so the destination
					// tab re-hydrates from its own persisted row instead of inheriting
					// the previous tab's settings.
					hydratedTypesRef.current.delete(displaySettingsKey)
					navigate({
						to: '/$workspaceId/objects',
						params: { workspaceId },
						search: {
							type: value || undefined,
							sort: 'createdAt',
							order: 'desc',
							status: undefined,
							driver: undefined,
							q: undefined,
							groupBy: undefined,
							ids: undefined,
							includeArchived: undefined,
						},
						replace: true,
					})
				}}
				search={q}
				onSearchChange={(value) => updateSearch({ q: value || undefined })}
				statusFilter={statusFilter}
				onStatusFilterChange={(value) => updateSearch({ status: value })}
				statusesByType={statusesByType}
				driverFilter={driverFilter}
				onDriverFilterChange={(value) => updateSearch({ driver: value })}
				actors={actors}
				fieldDefinitions={typeFieldDefinitions}
				metadataFilters={metadataFilters}
				onMetadataFilterChange={(field, value) => updateSearch({ [`metadata.${field}`]: value })}
				onResetFilters={() => {
					const cleared: Record<string, string | undefined> = {
						status: undefined,
						driver: undefined,
					}
					for (const key of Object.keys(searchParams)) {
						if (key.startsWith('metadata.')) cleared[key] = undefined
					}
					updateSearch(cleared)
				}}
				sort={sort}
				onSortChange={(value) =>
					updateSearch({
						sort: value,
						order: value === BOARD_MANUAL_SORT ? 'asc' : order,
					})
				}
				order={order}
				onOrderChange={(value) => updateSearch({ order: value })}
				groupBy={groupBy}
				onGroupByChange={(value) => updateSearch({ groupBy: value })}
				includeArchived={supportsIncludeArchived ? includeArchived : undefined}
				onIncludeArchivedChange={
					supportsIncludeArchived
						? // Must be the number 1, not the string '1' — the router's default
							// search stringifier round-trips through JSON.parse/stringify, so a
							// string that looks like valid JSON gets re-quoted (`includeArchived=%221%22`)
							// while a number serializes as the bare digit.
							(next) => updateSearch({ includeArchived: next ? 1 : undefined })
						: undefined
				}
				view={effectiveView}
				onViewChange={(next) => {
					setView(next)
					if (next === 'list' && sort === BOARD_MANUAL_SORT) {
						updateSearch({ sort: 'createdAt', order: 'desc' })
					}
					// One analytics line per user-initiated switch so we can count
					// distinct operators reaching for Board (the bet's success
					// criterion). Hydration also sets view but bypasses this path.
					trackEvent('objects_control_changed', {
						source: 'objects-page',
						control: 'view',
						value: next,
						objectType: typeFilter ?? null,
					})
				}}
				boardSupported={boardSupported}
				onImportClick={() => setImportOpen(true)}
				onNewClick={() => setCreatePickerOpen(true)}
			/>

			{hasChipFilters && (
				<div className="flex items-center gap-2 mx-6 mb-3 flex-wrap">
					{activeStatuses.length > 0 && (
						<FilterChip
							label="Status"
							value={statusChipValue}
							onRemove={() => updateSearch({ status: undefined })}
						/>
					)}
					{activeDrivers.length > 0 && (
						<FilterChip
							label="Driver"
							value={driverChipValue}
							onRemove={() => updateSearch({ driver: undefined })}
						/>
					)}
					{archivedChipActive && (
						<FilterChip
							label="Include"
							value="archived"
							onRemove={() => updateSearch({ includeArchived: undefined })}
						/>
					)}
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
						onClick={() =>
							updateSearch({
								status: undefined,
								driver: undefined,
								includeArchived: undefined,
							})
						}
					>
						Clear all
					</Button>
				</div>
			)}

			<ImportDialog open={importOpen} onOpenChange={setImportOpen} onImportStarted={trackImport} />
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="object"
				defaultObjectSubtype={typeFilter}
			/>

			{effectiveView === 'board' && typeFilter ? (
				<div className="pb-4 flex-1 min-h-0 overflow-x-auto overflow-y-hidden md:px-6">
					<BoardView
						objectType={typeFilter}
						columns={boardQuery.data?.columns ?? []}
						boardParams={boardParams ?? {}}
						pageSize={BOARD_PAGE_SIZE}
						statusesByType={statusesByType}
						workspaceId={workspaceId}
						isLoading={boardQuery.isLoading}
						actors={actors}
						selectedIds={selectedIds}
						onObjectSelectionChange={handleObjectSelectionChange}
						onObjectRangeSelectionChange={handleObjectRangeSelectionChange}
						sort={sort}
						order={order}
						groupBy={groupBy}
						displayColumns={columnInfo}
						columnVisibility={effectiveVisibility}
						onManualOrderChange={() => updateSearch({ sort: BOARD_MANUAL_SORT, order: 'asc' })}
					/>
				</div>
			) : (
				<DataTable
					data={allObjects}
					columns={columns}
					workspaceId={workspaceId}
					actors={actors}
					rowSelection={rowSelection}
					onRowSelectionChange={setRowSelection}
					columnVisibility={effectiveVisibility}
					onColumnVisibilityChange={setColumnVisibility}
					grouping={groupingState}
					meta={tableMeta}
					hasNextPage={infiniteQuery.hasNextPage}
					isFetchingNextPage={infiniteQuery.isFetchingNextPage}
					isError={infiniteQuery.isError}
					fetchNextPage={infiniteQuery.fetchNextPage}
					isLoading={infiniteQuery.isLoading}
					onGroupToggle={handleGroupToggle}
				/>
			)}
			<BulkActionBar
				selectedCount={selectedIds.length}
				statusOptions={bulkStatusOptions}
				ownerOptions={bulkOwnerOptions}
				onStatusChange={handleBulkStatusChange}
				onOwnerChange={handleBulkOwnerChange}
				onCopyLink={handleCopyLinks}
				onCopyTitle={handleCopyTitles}
				onCopyTitleAsLink={handleCopyTitlesAsLinks}
				onOpenLinks={handleOpenLinks}
				onDelete={handleBulkDelete}
				onClear={clearSelection}
			/>
		</div>
	)
}
