import { AskPanel } from '@/components/asks/ask-panel'
import { PageHeader } from '@/components/layout/page-header'
import { BoardView } from '@/components/objects/board/board-view'
import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { getStaticColumns } from '@/components/objects/data-table/columns'
import type { ColumnInfo } from '@/components/objects/data-table/data-table-controls'
import {
	DataTableToolbar,
	type ToolbarQuickChip,
} from '@/components/objects/data-table/data-table-toolbar'
import {
	type DisplayFilterSectionModel,
	pinToken,
} from '@/components/objects/data-table/display-filter-section'
import type { DisplayPanelView } from '@/components/objects/data-table/display-panel'
import { getDynamicColumns } from '@/components/objects/data-table/dynamic-columns'
import type { FieldDefinition } from '@/components/objects/field-value-input'
import { ListView, type ListViewHandle } from '@/components/objects/list/list-view'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { type FilterTabItem, FilterTabs } from '@/components/shared/filter-tabs'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useNotifications, useRespondNotification } from '@/hooks/use-notifications'
import { useObjectStars } from '@/hooks/use-object-stars'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useBulkResultHandlers, useBulkUpdateObjects } from '@/hooks/use-objects'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import {
	trackEvent,
	trackObjectsBoardArrived,
	trackObjectsListArrived,
	trackObjectsListGroupToggled,
} from '@/lib/analytics'
import { api } from '@/lib/api'
import type { DisplaySettingsBody, NotificationResponse, ObjectResponse } from '@/lib/api'
import { consumeArrivalNavType } from '@/lib/back-nav-tracker'
import { type BetStatusResult, buildBetStatuses } from '@/lib/bet-status'
import { MAX_CHAT_OBJECT_REFERENCES } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import {
	DEFAULT_ORDER,
	DEFAULT_SORT,
	fromUrlSearch,
	urlIsInDefaultShape as isUrlInDefaultShape,
	toBoardParams,
	toDisplaySettingsBody,
	toListParams,
} from '@/lib/objects-filter-model'
import type { ObjectsFilterModel } from '@/lib/objects-filter-model'
import {
	UPDATED_BUCKETS,
	UPDATED_BUCKET_LABELS,
	type UpdatedBucket,
	isUpdatedBucket,
	isUpdatedWithinWeek,
	updatedBucketOf,
} from '@/lib/objects-updated-buckets'
import { clearViewState, getViewState, patchViewState } from '@/lib/objects-view-state'
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
	component: ObjectsRoute,
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
		// Quick filters are client-side narrowings of the loaded rows, so they live
		// in the URL rather than the persisted DisplaySettings blob: a deep link to
		// "starred, updated today" has to carry its own filter set.
		const isOn = (v: unknown) => v === '1' || v === 1 || v === true || v === 'true'
		const fresh = isOn(search.fresh)
		const starred = isOn(search.starred)
		const updated = isUpdatedBucket(search.updated) ? search.updated : undefined
		// Attention is a client-side axis: "waiting on you" comes from pending
		// needs_input notifications and "agent working" from activeSessionId —
		// neither is a server-side list filter, so it narrows loaded rows only.
		const rawAttention = search.attention
		const attention =
			rawAttention === 'waiting' || rawAttention === 'working' ? rawAttention : undefined
		return {
			type: typeof search.type === 'string' ? search.type : undefined,
			status: typeof search.status === 'string' ? search.status : undefined,
			driver: typeof search.driver === 'string' ? search.driver : undefined,
			attention,
			fresh: fresh ? (1 as const) : undefined,
			starred: starred ? (1 as const) : undefined,
			updated,
			// ORDER BY rests on Last updated (mockup script 8725) — an absent param
			// reads as the shared default rather than pinning it into every URL.
			sort: typeof search.sort === 'string' ? search.sort : DEFAULT_SORT,
			order:
				typeof search.order === 'string' && ['asc', 'desc'].includes(search.order)
					? (search.order as 'asc' | 'desc')
					: DEFAULT_ORDER,
			q: typeof search.q === 'string' ? search.q : undefined,
			// GROUP BY rests on State (mockup 994–999). `none` is the explicit
			// "ungrouped" choice — without a sentinel, clearing the param would just
			// fall back to the default again.
			groupBy: typeof search.groupBy === 'string' ? search.groupBy : 'status',
			ids: typeof search.ids === 'string' ? search.ids : undefined,
			includeArchived: includeArchived ? (1 as const) : undefined,
			...metadataFilters,
		}
	},
})

const PAGE_SIZE = 50
const BOARD_PAGE_SIZE = 20
const BOARD_MANUAL_SORT = 'boardOrder'

// Recency and Starred come pinned out of the box (mockup 6029's
// `{ fresh: true, star: true, work: false }`). Both are workspace-agnostic —
// unlike a status or driver pin, they mean the same thing on day one as they
// do on day one hundred, so they are safe to pre-place in the chip row.
const DEFAULT_PINNED_FILTERS = ['quick:fresh', 'quick:starred']

function ObjectsRoute() {
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
		groupBy: groupByParam,
		ids: idsFilter,
		includeArchived: includeArchivedParam,
		attention,
		fresh: freshParam,
		starred: starredParam,
		updated,
	} = searchParams
	const includeArchived = includeArchivedParam === 1
	// `none` is the URL's way of saying "explicitly ungrouped".
	const groupBy = groupByParam === 'none' ? undefined : groupByParam
	const fresh = freshParam === 1
	const starred = starredParam === 1
	// Per the task scope, the "Show" section (with the Include archived toggle)
	// is bet-only for now — surfaced when the bet tab is active. Non-bet tabs
	// keep the existing panel shape until archive lands for their type.
	const supportsIncludeArchived = typeFilter === 'bet'

	const { starredIds } = useObjectStars(workspaceId)
	const objectTypeLabel = useObjectTypeLabel()
	// Which Display-panel filter options are promoted to the toolbar chip row.
	// Per-actor and per-tab, so it rides the same persisted DisplaySettings row
	// as the rest of the panel rather than a second store the panel can drift
	// from. Order is pin order — chips appear where the user put them.
	const [pinnedFilters, setPinnedFilters] = useState<string[]>(DEFAULT_PINNED_FILTERS)
	const handleTogglePinnedFilter = useCallback((token: string) => {
		setPinnedFilters((current) =>
			current.includes(token) ? current.filter((t) => t !== token) : [...current, token],
		)
	}, [])
	const [createPickerOpen, setCreatePickerOpen] = useState(false)
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

	// Group-expansion state is lifted from the List view so a POP landing can
	// silently rehydrate what the user had open before they drilled into a
	// row. Keys are react-table's grouped-row ids (`<columnId>:<groupValue>`)
	// so the map round-trips with blobs persisted by the DataTable era of this
	// route. Route-local: not persisted server-side, dies on tab close.
	const [expanded, setExpanded] = useState<Record<string, boolean>>({})
	// Latest first-visible row anchor captured at navigate-away time. Feeds
	// the debounced DisplaySettings write-through so a hard reload can bootstrap
	// the session store from the persisted value.
	const [capturedAnchor, setCapturedAnchor] = useState<string | null | undefined>(undefined)

	// Fires on every mount, with the nav_type resolved from popstate + the
	// initial PerformanceNavigationTiming entry. The ship-metric denominator
	// filters to `nav_type='back'` in PostHog; the `direct` / `link` variants
	// ride along so the arrival stream can be sliced by nav type later. The
	// tracker is initialised at app boot (see main.tsx) so deep-link starts
	// followed by a browser-back to the list are captured too. typeFilter is
	// intentionally excluded from deps — a tab switch changes it under a
	// stable mount and must not re-emit the arrival event.
	//
	// The same mount arms two restore effects: scroll anchor and group
	// expansion. Data isn't necessarily loaded yet at mount time, so both
	// wait for the display-settings hydrate (expansion) or the first row
	// page (scroll) before actually restoring.
	const shouldRestoreScrollRef = useRef(false)
	const shouldRestoreExpandedRef = useRef(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once event
	useEffect(() => {
		const navType = consumeArrivalNavType()
		if (navType === 'back') {
			shouldRestoreScrollRef.current = true
			shouldRestoreExpandedRef.current = true
		}
		trackObjectsListArrived({
			nav_type: navType,
			objectType: typeFilter ?? null,
		})
	}, [])

	// Imperative handle for the List view. Lets this route read the first-
	// visible row id at navigate-away and scroll back to it on a POP landing,
	// without lifting the row model out of the list. Same two-method contract
	// DataTableHandle exposed, so the capture/restore plumbing is unchanged.
	const listViewRef = useRef<ListViewHandle>(null)

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
	// Pending asks scoped to the current selection. An ask is a needs_input
	// notification whose object is one of the selected rows; Approve/Hold
	// round-trips through the respond endpoint and the panel reflects the done
	// state via the resolved status.
	const actorsById = useMemo(() => new Map((actors ?? []).map((a) => [a.id, a])), [actors])
	const [asksOpen, setAsksOpen] = useState(false)
	const { data: needsInputNotifications } = useNotifications(workspaceId, {
		type: 'needs_input',
	})
	const selectedAsks = useMemo(() => {
		if (!needsInputNotifications) return []
		const selected = new Set(selectedIds)
		return needsInputNotifications.filter((n) => n.objectId != null && selected.has(n.objectId))
	}, [needsInputNotifications, selectedIds])
	const askCount = selectedAsks.length
	// Pending asks keyed by the object they target, for the per-row ask line +
	// "Waiting on you" pill on the List surface. Only status 'pending' counts as
	// waiting — a resolved ask drops out of the map (and the row hides the pill).
	const pendingAsksByObjectId = useMemo(() => {
		const map = new Map<string, NotificationResponse>()
		for (const n of needsInputNotifications ?? []) {
			if (n.status !== 'pending' || !n.objectId) continue
			if (!map.has(n.objectId)) map.set(n.objectId, n)
		}
		return map
	}, [needsInputNotifications])
	const respondNotification = useRespondNotification(workspaceId)
	const handleRespond = useCallback(
		(id: string, response: 'approve' | 'hold') => {
			respondNotification.mutate({ id, response })
		},
		[respondNotification],
	)
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

	// The single shared filter model. Every view consumer — List params, Board
	// params, grouping, persistence — derives from this one object, so the two
	// views cannot drift apart: a filter set once reaches both by construction.
	const filterModel = useMemo<ObjectsFilterModel>(
		() =>
			fromUrlSearch({
				type: typeFilter,
				status: statusFilter,
				driver: driverFilter,
				sort,
				order,
				q,
				groupBy,
				ids: idsFilter,
				includeArchived,
				metadata: metadataFilters,
				columnVisibility,
			}),
		[
			typeFilter,
			statusFilter,
			driverFilter,
			sort,
			order,
			q,
			groupBy,
			idsFilter,
			includeArchived,
			metadataFilters,
			columnVisibility,
		],
	)

	// Build API filters for the List query from the shared model. The
	// include-archived flag is emitted only when the current tab supports it
	// (bet-only per T5); omitting it lets the route default (hide archived) ride.
	const filters = useMemo(
		() => toListParams(filterModel, { includeArchivedAllowed: supportsIncludeArchived }),
		[filterModel, supportsIncludeArchived],
	)

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

	// The Attention axis has no server-side equivalent — "waiting on you" is a
	// pending needs_input notification and "agent working" is a live session, so
	// it narrows the rows already loaded rather than the query. Applied to the
	// rendered rows only; type-tab counts and bulk-selection lookups stay on the
	// unfiltered set so a filtered-out selection can still be acted on.
	const matchesAttention = useCallback(
		(object: ObjectResponse) => {
			if (!attention) return true
			if (attention === 'waiting') return pendingAsksByObjectId.has(object.id)
			return !!object.activeSessionId
		},
		[attention, pendingAsksByObjectId],
	)
	// Quick + Updated narrow the same way, and for the same reason: neither
	// recency buckets nor a personal star set exist server-side. Type-tab counts
	// and bulk-selection lookups stay on the unfiltered set so a filtered-out
	// selection can still be acted on.
	const hasClientFilter = !!attention || fresh || starred || !!updated
	const matchesClientFilters = useCallback(
		(object: ObjectResponse) =>
			matchesAttention(object) &&
			(!fresh || isUpdatedWithinWeek(object)) &&
			(!starred || starredIds.has(object.id)) &&
			(!updated || updatedBucketOf(object.updatedAt) === updated),
		[matchesAttention, fresh, starred, starredIds, updated],
	)
	const listObjects = useMemo(
		() => (hasClientFilter ? allObjects.filter(matchesClientFilters) : allObjects),
		[hasClientFilter, allObjects, matchesClientFilters],
	)

	// Per-tab live counts for the type tab strip. Counts reflect the objects
	// loaded so far (the list paginates via infinite query) — they update as
	// more pages load, which is the right trade-off vs. a separate count query.
	// Any narrowing that makes a type's count unrepresentative of the workspace.
	// `typeFilter` counts as a narrowing here too: with a type selected the API
	// returns only that type, so every other tab's count is 0 and the hide rule
	// below would prune the tabs you need to switch back with — a one-way door
	// out of the All tab.
	const hasActiveFilterForTabs =
		!!typeFilter ||
		!!statusFilter ||
		!!driverFilter ||
		!!attention ||
		fresh ||
		starred ||
		!!updated ||
		!!q

	const countsByType = useMemo(() => {
		const counts: Record<string, number> = { all: allObjects.length }
		for (const tab of tabs) {
			if (!tab.value) continue
			counts[tab.value] = allObjects.filter((o) => o.type === tab.value).length
		}
		return counts
	}, [tabs, allObjects])
	// The mockup keeps `All` always and drops every type tab with nothing in it
	// (`.filter(c => c.val === null || c.count > 0)`, script 5921) — an empty
	// workspace shows one tab, not a row of zeroes.
	//
	// It counts those tabs from the pre-filter pool (script 5886's `activePool`),
	// so a status or driver filter never removes a tab. Our counts come from the
	// filtered API result instead, so the same rule would make every other type
	// disappear the moment a filter is applied — the workspace would look like it
	// had lost its types. While any filter is active we therefore show the full
	// tab set; the hide rule only prunes types the workspace genuinely never uses.
	const tabsWithCounts = useMemo(() => {
		const withCounts = tabs.map((t) => ({
			...t,
			count: t.value ? countsByType[t.value] : countsByType.all,
		}))
		if (hasActiveFilterForTabs) return withCounts
		return withCounts.filter((t) => !t.value || t.count > 0 || t.value === typeFilter)
	}, [tabs, countsByType, typeFilter, hasActiveFilterForTabs])

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
	// Every enabled type that could render a board, in tab order. The Display
	// panel's Board control is offered whenever this is non-empty — not only
	// when the *current* type qualifies — because the mockup treats Board as a
	// destination rather than a mode: `setObjBoard` sets the type to a
	// board-capable one and switches, instead of greying the control out on the
	// All tab and leaving the user with nothing to click (script 7834).
	const boardCapableTypes = useMemo(() => {
		const statusMap = settings?.statuses as Record<string, string[]> | undefined
		if (!statusMap) return []
		const enabled = new Set(tabs.map((t) => t.value).filter(Boolean))
		return tabs
			.map((t) => t.value)
			.filter((type): type is string => !!type && enabled.has(type))
			.filter((type) => (statusMap[type]?.length ?? 0) > 0)
	}, [settings, tabs])
	// Bet is the mockup's own board type, so it wins when the workspace has it.
	const boardLandingType = boardCapableTypes.includes('bet') ? 'bet' : boardCapableTypes[0]
	// Effective view: even if the user previously chose Board for this type, an
	// unsupported context (All tab, type with zero configured statuses) renders
	// List. We never write that fallback back to settings — the stored
	// preference is preserved for when the type becomes board-capable again.
	const effectiveView: DisplayPanelView = boardSupported ? view : 'list'

	const boardParams = useMemo(
		() =>
			toBoardParams(filterModel, {
				pageSize: BOARD_PAGE_SIZE,
				includeArchivedAllowed: supportsIncludeArchived,
			}),
		[filterModel, supportsIncludeArchived],
	)

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

	// Board arrival telemetry, mirroring the List's on-mount event. Fires when
	// the board becomes the effective view (a list->board switch or a reload
	// that lands directly on board), not on every type switch while already on it.
	const prevEffectiveViewRef = useRef(effectiveView)
	useEffect(() => {
		const enteredBoard = prevEffectiveViewRef.current !== 'board' && effectiveView === 'board'
		prevEffectiveViewRef.current = effectiveView
		if (enteredBoard) trackObjectsBoardArrived({ objectType: typeFilter ?? null })
	}, [effectiveView, typeFilter])

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

	// Bet status indicator wiring — the row renders `IndicatorBadgeRow`
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

	// Bet status is rendered beside the title (not as its own column), so
	// its show/hide toggle lives in the same `columnVisibility` map as the real
	// columns and is threaded into the row via `showBetStatusIndicator`.
	const showBetStatusIndicator = columnVisibility.betStatusIndicator !== false

	// Columns — feed the Display panel's column picker (the List view itself
	// renders a fixed compact anatomy, not these column definitions).
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

	// Grouping state derives from the shared model.
	const groupingState: GroupingState = filterModel.groupBy ? [filterModel.groupBy] : []

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

	// "Reset to default" from the Display menu — restores every display axis on
	// the shared model: order back to the route default, no grouping, all filters
	// (status/driver/metadata) cleared, archived hidden, columns back to the
	// default set. `view` and `q` are deliberately untouched (separate surfaces).
	const handleResetToDefault = useCallback(() => {
		const cleared: Record<string, string | undefined> = {
			sort: DEFAULT_SORT,
			order: DEFAULT_ORDER,
			groupBy: undefined,
			status: undefined,
			driver: undefined,
			attention: undefined,
			fresh: undefined,
			starred: undefined,
			updated: undefined,
			includeArchived: undefined,
		}
		for (const key of Object.keys(searchParams)) {
			if (key.startsWith('metadata.')) cleared[key] = undefined
		}
		updateSearch(cleared)
		setColumnVisibility({ createdBy: false })
	}, [updateSearch, searchParams])

	// Per-actor display settings (persistence layer from Task 5).
	// Hydration policy: when the user lands on a tab with persisted settings
	// and the URL is in its default shape, apply the saved view. Once any
	// tracked field changes we write the whole blob back. The All tab uses
	// the `__all__` sentinel slot so its column-visibility toggles persist
	// the same way per-type tabs do — without that, the user's choices in
	// the display menu reset to defaults on every navigation away and back.
	const displaySettingsKey = typeFilter ?? ALL_TYPES_KEY

	// Fired synchronously by DataTable right before the row-click navigate.
	// Snapshots the first-visible row id into the session view-state store so
	// a back-nav landing (below) can restore the anchor. Keyed by workspace +
	// tab so an anchor from one tab never rehydrates onto another. Also feeds
	// `capturedAnchor` state which rides the debounced DisplaySettings write-
	// through — T2's DoD asks for scroll-anchor changes to persist through
	// the same rail as columnVisibility.
	const handleCaptureViewState = useCallback(() => {
		const firstVisibleRowId = listViewRef.current?.getFirstVisibleRowId() ?? null
		patchViewState(workspaceId, displaySettingsKey, { firstVisibleRowId })
		setCapturedAnchor(firstVisibleRowId)
	}, [workspaceId, displaySettingsKey])

	// Silent scroll restore on POP landings. Waits for the first page of data
	// so `scrollToIndex` has real rows to resolve against — scrolling an empty
	// list would produce jitter and then re-fire on the next render. Fires
	// exactly once per POP: the ref is cleared after the first attempt (which
	// itself may no-op silently if the persisted row id is no longer in the
	// current row set — deleted row, or the URL filter shifted).
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires once when the load-gate flips; ref reads current key
	useEffect(() => {
		if (!shouldRestoreScrollRef.current) return
		if (infiniteQuery.isLoading) return
		if (allObjects.length === 0) return
		const { firstVisibleRowId } = getViewState(workspaceId, displaySettingsKey)
		if (firstVisibleRowId) {
			listViewRef.current?.scrollToRowId(firstVisibleRowId)
		}
		shouldRestoreScrollRef.current = false
	}, [infiniteQuery.isLoading, allObjects.length])

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
	// Set when the user picks Board from a tab that can't render one. The switch
	// to a board-capable type re-arms hydration for BOTH the outgoing and the
	// destination key, and hydration restores that tab's own saved view — which
	// would swallow the choice the user just made. Keyed by destination so the
	// outgoing tab's pass can't consume it first.
	const pendingViewRef = useRef<{ key: string; view: DisplayPanelView } | null>(null)

	const urlIsInDefaultShape = useMemo(
		() => isUrlInDefaultShape(searchParams, metadataFilters),
		[searchParams, metadataFilters],
	)

	useEffect(() => {
		if (hydratedTypesRef.current.has(displaySettingsKey)) return
		// A failed read is treated like "nothing persisted": there is no saved
		// view to apply either way, and gating on `isSuccess` alone would leave
		// the write-through effect disarmed for the rest of the session, so
		// nothing the user changed afterwards would ever be saved.
		if (!displaySettingsQuery.isSuccess && !displaySettingsQuery.isError) return
		// Mark hydrated even if there are no persisted settings yet — that lets
		// the write-through effect start tracking once the user makes their
		// first change, without re-running this hydrate block.
		hydratedTypesRef.current.add(displaySettingsKey)
		const pending = pendingViewRef.current
		const pendingView = pending?.key === displaySettingsKey ? pending.view : null
		if (pendingView) pendingViewRef.current = null
		const persisted = displaySettingsQuery.data
		if (!persisted) {
			// No saved view for this key — fall back to the route default.
			setView(pendingView ?? 'list')
			setPinnedFilters(DEFAULT_PINNED_FILTERS)
			return
		}
		const s = persisted.settings
		// View hydrates regardless of urlIsInDefaultShape: `view` is route-local
		// (not in the URL), so the URL's shape can't conflict with it.
		setView(pendingView ?? s.view ?? 'list')
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
		// `?? DEFAULT` only for a row saved before pins existed — an explicit empty
		// array is a user who unpinned everything, and must survive a reload.
		setPinnedFilters(s.pinnedFilters ?? DEFAULT_PINNED_FILTERS)
		// Cross-session bootstrap for the group-expansion + scroll-anchor
		// state that T1 extended on the shared DisplaySettingsBody. In-session
		// restore comes from the ephemeral view-state store (session-scoped by
		// design — see the shouldRestoreScrollRef + shouldRestoreExpandedRef
		// effects); this seeds that store when a hard reload wipes it but the
		// persisted row still has values. `groupExpanded` also drives the
		// initial DataTable state directly so the very first render already
		// shows the last-known expanded groups instead of a top-of-list flash.
		if (s.groupExpanded && Object.keys(s.groupExpanded).length > 0) {
			setExpanded(s.groupExpanded)
			patchViewState(workspaceId, displaySettingsKey, {
				expandedGroupIds: s.groupExpanded,
			})
		}
		if (s.firstVisibleRowId) {
			patchViewState(workspaceId, displaySettingsKey, {
				firstVisibleRowId: s.firstVisibleRowId,
			})
			setCapturedAnchor(s.firstVisibleRowId)
		} else {
			setCapturedAnchor(null)
		}
	}, [
		displaySettingsKey,
		displaySettingsQuery.isSuccess,
		displaySettingsQuery.isError,
		displaySettingsQuery.data,
		urlIsInDefaultShape,
		updateSearch,
		workspaceId,
	])

	// Silent group-expansion restore on the POP-landing mount. Tied to the
	// same first-hydrate gate the display-settings block uses so the restore
	// lands on the same render as the persisted view/columns — no visible
	// flip. POP-only (arm-once ref); PUSH/REPLACE landings never restore.
	// Also fires once per POP: the ref is consumed on the first attempt
	// (even when the persisted map is empty), so later in-page tab switches
	// inside the same mount never rehydrate.
	useEffect(() => {
		if (!shouldRestoreExpandedRef.current) return
		if (!displaySettingsQuery.isSuccess) return
		if (!hydratedTypesRef.current.has(displaySettingsKey)) return
		shouldRestoreExpandedRef.current = false
		const { expandedGroupIds } = getViewState(workspaceId, displaySettingsKey)
		if (Object.keys(expandedGroupIds).length === 0) return
		setExpanded(expandedGroupIds)
		trackObjectsListGroupToggled({
			source: 'system',
			expanded: true,
			objectType: typeFilter ?? null,
		})
	}, [displaySettingsKey, displaySettingsQuery.isSuccess, workspaceId, typeFilter])

	// Group-expansion writes flow through here — the ListView is fully
	// controlled. On every user toggle: apply the update, patch the resulting
	// map into the session store for the current key, and fire the group-
	// toggle analytics with source: 'user'. The silent restore above bypasses
	// this handler (it calls `setExpanded` directly), so every fire here is
	// user-initiated by construction. `expanded` on the analytics payload is
	// the net direction of the update — true when the number of explicitly
	// collapsed groups shrank (user opened one), false when it grew.
	const handleExpandedChange = useCallback(
		(next: Record<string, boolean>) => {
			// Keep the map verbatim, `false` entries included. Groups now rest
			// open, so a collapse is recorded as an explicit `false` — dropping
			// it would silently re-open the group on the next render. DataTable-
			// era blobs (only `true` values) still round-trip unchanged.
			const nextMap: Record<string, boolean> = { ...next }
			const prevClosed = Object.values(expanded).filter((v) => v === false).length
			const nextClosed = Object.values(nextMap).filter((v) => v === false).length
			setExpanded(nextMap)
			patchViewState(workspaceId, displaySettingsKey, { expandedGroupIds: nextMap })
			trackObjectsListGroupToggled({
				source: 'user',
				expanded: nextClosed < prevClosed,
				objectType: typeFilter ?? null,
			})
		},
		[workspaceId, displaySettingsKey, typeFilter, expanded],
	)

	// Write-through. Only fires after this key has been hydrated so the
	// initial apply doesn't immediately re-write the same blob back.
	// T2 also folds groupExpanded + firstVisibleRowId into the same debounced
	// rail so a hard reload can re-seed the session view-state store from the
	// last-known values. The in-session restore paths still come from the
	// ephemeral store; this write is a cross-session backstop.
	useEffect(() => {
		if (!hydratedTypesRef.current.has(displaySettingsKey)) return
		const settings: DisplaySettingsBody = {
			...toDisplaySettingsBody(filterModel),
			view,
		}
		// Always written, empty included — see the hydrate note above.
		settings.pinnedFilters = pinnedFilters
		if (Object.keys(expanded).length > 0) {
			settings.groupExpanded = expanded
		}
		// Persist both string (anchor) and null (deliberate top). Skip
		// `undefined` — the pre-hydration sentinel. Once hydrated, the state
		// flips to at least null, so we always emit the field afterwards.
		if (capturedAnchor !== undefined) {
			settings.firstVisibleRowId = capturedAnchor
		}

		const handle = setTimeout(() => {
			updateMutateRef.current({ objectType: displaySettingsKey, settings })
		}, 500)
		return () => clearTimeout(handle)
	}, [displaySettingsKey, view, filterModel, expanded, capturedAnchor, pinnedFilters])

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

	// Board columns, narrowed by the client-side Attention axis so List and
	// Board answer the same question. Totals shrink with the visible rows.
	const boardColumns = useMemo(() => {
		const columns = boardQuery.data?.columns ?? []
		if (!attention) return columns
		return columns.map((column) => {
			const objects = column.objects.filter(matchesAttention)
			return { ...column, objects, total: objects.length }
		})
	}, [boardQuery.data, attention, matchesAttention])

	const attentionCounts = useMemo(() => {
		let waiting = 0
		let working = 0
		for (const object of allObjects) {
			if (pendingAsksByObjectId.has(object.id)) waiting++
			if (object.activeSessionId) working++
		}
		return { waiting, working }
	}, [allObjects, pendingAsksByObjectId])

	// Wrapped rather than passed by reference: `filter` would hand the array
	// index in as the `now` argument.
	const freshCount = useMemo(
		() => allObjects.filter((o) => isUpdatedWithinWeek(o)).length,
		[allObjects],
	)
	const starredCount = useMemo(
		() => allObjects.filter((o) => starredIds.has(o.id)).length,
		[allObjects, starredIds],
	)

	const statusCounts = useMemo(() => {
		const counts = new Map<string, number>()
		for (const object of allObjects) {
			counts.set(object.status, (counts.get(object.status) ?? 0) + 1)
		}
		return counts
	}, [allObjects])

	const driverCounts = useMemo(() => {
		const counts = new Map<string, number>()
		for (const object of allObjects) {
			if (!object.driver) continue
			counts.set(object.driver, (counts.get(object.driver) ?? 0) + 1)
		}
		return counts
	}, [allObjects])

	const updatedCounts = useMemo(() => {
		const counts = new Map<UpdatedBucket, number>()
		for (const object of allObjects) {
			const bucket = updatedBucketOf(object.updatedAt)
			if (!bucket) continue
			counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
		}
		return counts
	}, [allObjects])

	// Single-select toggles: picking the active value again clears the axis, so
	// a chip is always its own off-switch (mockup `on ? null : key`).
	const toggleStatus = useCallback(
		(status: string) =>
			updateSearch({ status: activeStatuses.join(',') === status ? undefined : status }),
		[activeStatuses, updateSearch],
	)
	const toggleDriver = useCallback(
		(driverId: string) =>
			updateSearch({ driver: activeDrivers.join(',') === driverId ? undefined : driverId }),
		[activeDrivers, updateSearch],
	)
	const toggleAttention = useCallback(
		(value: 'waiting' | 'working') =>
			updateSearch({ attention: attention === value ? undefined : value }),
		[attention, updateSearch],
	)

	// The four FILTERS axes, in the mockup's order. Built once and consumed
	// twice — by the Display panel's collapsible rows and by the toolbar's
	// pinned-chip row — so a pinned chip can never disagree with the panel row
	// it was promoted from.
	const filterSections = useMemo<DisplayFilterSectionModel[]>(() => {
		const statuses = [...new Set(Object.values(statusesByType).flat())]
		const driverOptions = (actors ?? []).filter((actor) => driverCounts.has(actor.id))
		return [
			{
				id: 'quick',
				label: 'Quick',
				summary:
					[fresh && 'New last 7 days', starred && 'Starred', attention === 'working' && 'Working']
						.filter(Boolean)
						.join(', ') || 'None',
				options: [
					{
						id: 'fresh',
						label: 'New last 7 days',
						count: freshCount,
						active: fresh,
						onToggle: () => updateSearch({ fresh: fresh ? undefined : 1 }),
					},
					{
						id: 'starred',
						label: 'Starred',
						count: starredCount,
						active: starred,
						onToggle: () => updateSearch({ starred: starred ? undefined : 1 }),
					},
					{
						id: 'working',
						label: 'Working',
						count: attentionCounts.working,
						active: attention === 'working',
						onToggle: () => toggleAttention('working'),
					},
					{
						id: 'waiting',
						label: 'Waiting on you',
						count: attentionCounts.waiting,
						active: attention === 'waiting',
						onToggle: () => toggleAttention('waiting'),
					},
				],
			},
			{
				id: 'updated',
				label: 'Updated',
				summary: updated ? UPDATED_BUCKET_LABELS[updated] : 'Any time',
				options: UPDATED_BUCKETS.map((bucket) => ({
					id: bucket,
					label: UPDATED_BUCKET_LABELS[bucket],
					count: updatedCounts.get(bucket) ?? 0,
					active: updated === bucket,
					onToggle: () => updateSearch({ updated: updated === bucket ? undefined : bucket }),
				})),
			},
			{
				id: 'status',
				label: 'Status',
				summary: activeStatuses.length > 0 ? statusChipValue : 'Any status',
				options: statuses.map((status) => ({
					id: status,
					label: status.replace(/_/g, ' '),
					count: statusCounts.get(status) ?? 0,
					active: activeStatuses.includes(status),
					onToggle: () => toggleStatus(status),
				})),
			},
			{
				id: 'driver',
				label: 'Driver',
				summary: activeDrivers.length > 0 ? driverChipValue : 'Anyone',
				options: driverOptions.map((actor) => ({
					id: actor.id,
					label: actor.name,
					count: driverCounts.get(actor.id) ?? 0,
					active: activeDrivers.includes(actor.id),
					onToggle: () => toggleDriver(actor.id),
				})),
			},
		]
	}, [
		statusesByType,
		actors,
		fresh,
		starred,
		attention,
		updated,
		freshCount,
		starredCount,
		attentionCounts,
		updatedCounts,
		statusCounts,
		driverCounts,
		activeStatuses,
		activeDrivers,
		statusChipValue,
		driverChipValue,
		updateSearch,
		toggleStatus,
		toggleDriver,
		toggleAttention,
	])

	// Pinned options, resolved back to live toggles in pin order. A token whose
	// option no longer exists (a status removed from the workspace, a driver who
	// left) is skipped rather than rendered dead — the pin stays stored so the
	// chip returns if the value does.
	const quickChips = useMemo<ToolbarQuickChip[]>(() => {
		const byToken = new Map<string, ToolbarQuickChip>()
		for (const section of filterSections) {
			for (const option of section.options) {
				byToken.set(pinToken(section.id, option.id), {
					id: pinToken(section.id, option.id),
					// Quick toggles are self-describing ("Starred"); a status or driver
					// value is not, so it carries its axis into the chip row.
					label:
						section.id !== 'quick'
							? `${section.label}: ${option.label}`
							: option.id === 'starred'
								? `★ ${option.label}`
								: option.label,
					active: option.active,
					onToggle: option.onToggle,
				})
			}
		}
		return pinnedFilters
			.map((token) => byToken.get(token))
			.filter((c): c is ToolbarQuickChip => !!c)
	}, [filterSections, pinnedFilters])

	const clearAllFilters = useCallback(() => {
		const cleared: Record<string, string | number | undefined> = {
			status: undefined,
			driver: undefined,
			attention: undefined,
			fresh: undefined,
			starred: undefined,
			updated: undefined,
			includeArchived: undefined,
			q: undefined,
		}
		for (const key of Object.keys(searchParamsRef.current)) {
			if (key.startsWith('metadata.')) cleared[key] = undefined
		}
		updateSearch(cleared)
	}, [updateSearch])

	// Every active filter as a removable pill (mockup 914–918) — except one
	// whose option is pinned. A pinned chip already renders that filter's on/off
	// state, and a pill beside it would be a second control for the same bit
	// (mockup 6015/6018/6019 gate every pill on `!pinsF[...]`).
	const pinnedSet = useMemo(() => new Set(pinnedFilters), [pinnedFilters])
	const filterPills = useMemo(() => {
		const pills: Array<{ id: string; label: string; value: string; onRemove: () => void }> = []
		if (activeStatuses.length > 0 && !activeStatuses.every((v) => pinnedSet.has(`status:${v}`))) {
			pills.push({
				id: 'status',
				label: 'Status',
				value: statusChipValue,
				onRemove: () => updateSearch({ status: undefined }),
			})
		}
		if (activeDrivers.length > 0 && !activeDrivers.every((v) => pinnedSet.has(`driver:${v}`))) {
			pills.push({
				id: 'driver',
				label: 'Driver',
				value: driverChipValue,
				onRemove: () => updateSearch({ driver: undefined }),
			})
		}
		if (attention && !pinnedSet.has(`quick:${attention}`)) {
			pills.push({
				id: 'attention',
				label: 'Attention',
				value: attention === 'waiting' ? 'waiting on you' : 'agent working',
				onRemove: () => updateSearch({ attention: undefined }),
			})
		}
		if (fresh && !pinnedSet.has('quick:fresh')) {
			pills.push({
				id: 'fresh',
				label: 'Quick',
				value: 'new last 7 days',
				onRemove: () => updateSearch({ fresh: undefined }),
			})
		}
		if (starred && !pinnedSet.has('quick:starred')) {
			pills.push({
				id: 'starred',
				label: 'Quick',
				value: 'starred',
				onRemove: () => updateSearch({ starred: undefined }),
			})
		}
		if (updated && !pinnedSet.has(`updated:${updated}`)) {
			pills.push({
				id: 'updated',
				label: 'Updated',
				value: UPDATED_BUCKET_LABELS[updated].toLowerCase(),
				onRemove: () => updateSearch({ updated: undefined }),
			})
		}
		for (const [field, value] of Object.entries(metadataFilters)) {
			if (!value) continue
			pills.push({
				id: `metadata.${field}`,
				label: field.replace(/_/g, ' '),
				value,
				onRemove: () => updateSearch({ [`metadata.${field}`]: undefined }),
			})
		}
		if (archivedChipActive) {
			pills.push({
				id: 'archived',
				label: 'Include',
				value: 'archived',
				onRemove: () => updateSearch({ includeArchived: undefined }),
			})
		}
		if (q) {
			pills.push({
				id: 'q',
				label: 'Search',
				value: q,
				onRemove: () => updateSearch({ q: undefined }),
			})
		}
		return pills
	}, [
		activeStatuses,
		activeDrivers,
		attention,
		fresh,
		starred,
		updated,
		metadataFilters,
		archivedChipActive,
		q,
		statusChipValue,
		driverChipValue,
		pinnedSet,
		updateSearch,
	])

	// Whether the list is narrowed at all. Deliberately NOT `filterPills.length`:
	// a pinned filter renders as a chip instead of a pill, so counting pills would
	// report "unfiltered" for a workspace that is very much filtered — and the
	// empty state would then offer no way back out.
	const hasAnyActiveFilter =
		activeStatuses.length > 0 ||
		activeDrivers.length > 0 ||
		!!attention ||
		fresh ||
		starred ||
		!!updated ||
		!!q ||
		archivedChipActive ||
		Object.values(metadataFilters).some(Boolean)

	// Filtered-empty sentence, built from what is actually applied (mockup 1021).
	const filteredEmptyTitle = useMemo(() => {
		if (!hasAnyActiveFilter) return 'No objects found'
		const noun = typeFilter ? `${typeFilter}s` : 'objects'
		const clauses: string[] = []
		if (attention === 'waiting') clauses.push('waiting on you')
		if (attention === 'working') clauses.push('with an agent working')
		if (starred) clauses.push('you starred')
		if (fresh) clauses.push('touched in the last 7 days')
		if (updated) clauses.push(`updated ${UPDATED_BUCKET_LABELS[updated].toLowerCase()}`)
		if (activeStatuses.length > 0) clauses.push(`in ${statusChipValue}`)
		if (activeDrivers.length > 0) clauses.push(`driven by ${driverChipValue}`)
		if (q) clauses.push(`matching “${q}”`)
		return clauses.length === 0
			? `No ${noun} match these filters.`
			: `No ${noun} ${clauses.join(' ')} right now.`
	}, [
		hasAnyActiveFilter,
		typeFilter,
		attention,
		starred,
		fresh,
		updated,
		activeStatuses.length,
		activeDrivers.length,
		statusChipValue,
		driverChipValue,
		q,
	])

	// Archived rows only exist in the loaded set while the toggle is on, so the
	// count is only truthful then — omitted otherwise rather than shown as 0.
	const archivedCount = useMemo(
		() =>
			supportsIncludeArchived && includeArchived
				? allObjects.filter((o) => o.status === 'archived').length
				: undefined,
		[supportsIncludeArchived, includeArchived, allObjects],
	)

	const bulkOwnerOptions = useMemo(
		() => (actors ?? []).map((a) => ({ id: a.id, name: a.name })),
		[actors],
	)

	const bulkUpdate = useBulkUpdateObjects(workspaceId)
	const queryClient = useQueryClient()

	// Single-object status advance from the board card's `→` affordance.
	// The bulk endpoint reports per-row failures as HTTP 200 with
	// `results:[{ok:false,error}]`, so `onError` alone never fires for them and
	// the optimistic patch would sit there until `onSettled` refetched and
	// snapped the card back with nothing said. Mirrors the drag path's check in
	// `board-view.tsx` — a missing entry counts as a failure, since the server
	// never confirmed this id.
	const handleAdvanceStatus = useCallback(
		(objectId: string, status: string) => {
			bulkUpdate.mutate(
				{ ids: [objectId], patch: { status } },
				{
					onSuccess: (data) => {
						const result = Array.isArray(data?.results)
							? data.results.find((item) => item.id === objectId)
							: undefined
						if (!result?.ok) toast.error(result?.error ?? 'Failed to move object')
					},
					onError: () => toast.error('Failed to move object'),
				},
			)
		},
		[bulkUpdate],
	)

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

	// Archive is a dedicated bulk action because 'archived' is never among the
	// active status options the picker offers (archived rows are hidden by
	// default) — mirror the per-row archive semantic on object-document.
	const handleBulkArchive = useCallback(() => {
		if (selectedIds.length === 0) return
		const ids = [...selectedIds]
		bulkUpdate.mutate(
			{ ids, patch: { status: 'archived' } },
			{
				onSuccess: (data) => {
					retainOnlyFailed(data)
					reportBulkResult(data, ids.length, 'updated')
				},
				onError: () => toast.error('Failed to archive objects'),
			},
		)
	}, [selectedIds, bulkUpdate, reportBulkResult, retainOnlyFailed])

	// Build the path the app uses for object detail pages — kept relative so we can
	// resolve to an absolute URL for clipboard payloads but pass the path directly
	// to window.open for new-tab navigation.
	const objectPath = useCallback((id: string) => `/${workspaceId}/objects/${id}`, [workspaceId])

	// The rows `Select all` is allowed to reach. Deliberately the *rendered* set,
	// not `visibleObjects`: the quick filters narrow what each view shows, and
	// selecting past them would hand bulk actions rows the user can't see. The
	// list gets that for free from `listObjects`; the board filters here with the
	// same predicate it passes to `BoardView` as `clientFilter`.
	const selectableObjects = useMemo(() => {
		if (effectiveView !== 'board') return listObjects
		return hasClientFilter ? boardInitialObjects.filter(matchesClientFilters) : boardInitialObjects
	}, [effectiveView, listObjects, hasClientFilter, boardInitialObjects, matchesClientFilters])

	const handleSelectAll = useCallback(() => {
		setRowSelection(Object.fromEntries(selectableObjects.map((o) => [o.id, true])))
	}, [selectableObjects])

	// Hands the selection to a new chat as *references* rather than acting on it
	// in place — `chats/new` reads `objectIds` as a comma-separated list.
	//
	// Trimmed here rather than at the far end: `Select all` will happily select
	// more objects than the chat can resolve into chips, and a link that carries
	// ids nothing will render is how the extras used to disappear without a
	// word. Cut the list where it stops being deliverable, and say so.
	const handleAskAgent = useCallback(() => {
		if (selectedIds.length === 0) return
		const carried = selectedIds.slice(0, MAX_CHAT_OBJECT_REFERENCES)
		if (selectedIds.length > carried.length) {
			toast.warning(
				`Only the first ${carried.length} of ${selectedIds.length} selected objects were attached to the chat.`,
			)
		}
		navigate({
			to: '/$workspaceId/chats/new',
			params: { workspaceId },
			search: { objectIds: carried.join(',') },
		})
	}, [selectedIds, navigate, workspaceId])

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

	// Type-tab switch. Owned by the route (not the nav) because it resets the
	// per-tab hydration gate, the session view-state slot, and the whole search
	// shape — the nav only renders the strip this handler is bound into.
	const handleTypeFilterChange = useCallback(
		(value: string | undefined) => {
			// Clear the outgoing key (real type or `__all__`) so the destination
			// tab re-hydrates from its own persisted row instead of inheriting
			// the previous tab's settings.
			hydratedTypesRef.current.delete(displaySettingsKey)
			// Same story for the session view-state — an expansion or scroll
			// anchor built on the outgoing tab must not leak back onto it if the
			// user returns. Drop the store slot and reset local expanded so the
			// destination tab starts at its own defaults.
			clearViewState(workspaceId, displaySettingsKey)
			setExpanded({})
			setCapturedAnchor(undefined)
			navigate({
				to: '/$workspaceId/objects',
				params: { workspaceId },
				search: {
					type: value || undefined,
					sort: DEFAULT_SORT,
					order: DEFAULT_ORDER,
					status: undefined,
					driver: undefined,
					attention: undefined,
					fresh: undefined,
					starred: undefined,
					updated: undefined,
					q: undefined,
					groupBy: 'status',
					ids: undefined,
					includeArchived: undefined,
				},
				replace: true,
			})
		},
		[displaySettingsKey, workspaceId, navigate],
	)

	// Published into the shared nav row's *left* cluster, immediately after the
	// <h1> — the mockup puts the type tabs beside "Objects" (146–153), not out
	// beyond the search field. PageHeader's effect deps are `[titleTabs]`, so a
	// fresh node every render would re-set context state on every pass;
	// memoised for that reason.
	const headerTabs = useMemo(
		() => (
			<FilterTabs
				variant="nav"
				tabs={tabsWithCounts}
				value={typeFilter}
				onChange={handleTypeFilterChange}
				aria-label="Type filter"
				className="ml-[14px] min-w-0"
			/>
		),
		[tabsWithCounts, typeFilter, handleTypeFilterChange],
	)

	return (
		// The shared scroll area already supplies the page gutter, so the screen
		// only claims the column + the overflow lock: exactly one scroller (the
		// list/board region) on this route, matching the mockup's frame (852).
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			{/* No subtitle: the mockup's Objects header carries the count on the
			    active type tab (`All 1,063`), not beside the <h1> — printing it in
			    both places states the same number twice, three characters apart. */}
			<PageHeader title="Objects" titleTabs={headerTabs} scrollLocked />
			{idsFilter && (
				<div className="mb-3 flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
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
				quickChips={quickChips}
				filterPills={filterPills}
				onClearAllFilters={clearAllFilters}
				filterSections={filterSections}
				pinnedFilters={pinnedFilters}
				onTogglePinnedFilter={handleTogglePinnedFilter}
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
					const cleared: Record<string, string | number | undefined> = {
						status: undefined,
						driver: undefined,
						attention: undefined,
						fresh: undefined,
						starred: undefined,
						updated: undefined,
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
				onGroupByChange={(value) => updateSearch({ groupBy: value ?? 'none' })}
				includeArchived={supportsIncludeArchived ? includeArchived : undefined}
				archivedCount={archivedCount}
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
					// Board on a type that can't render one (the All tab, or a type with
					// no configured statuses) lands on the board-capable type rather
					// than refusing the click.
					if (next === 'board' && !boardSupported) {
						if (!boardLandingType) return
						pendingViewRef.current = { key: boardLandingType, view: 'board' }
						setView('board')
						handleTypeFilterChange(boardLandingType)
						trackEvent('objects_control_changed', {
							source: 'objects-page',
							control: 'view',
							value: next,
							objectType: boardLandingType,
						})
						return
					}
					setView(next)
					if (next === 'list' && sort === BOARD_MANUAL_SORT) {
						updateSearch({ sort: DEFAULT_SORT, order: DEFAULT_ORDER })
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
				boardSupported={boardSupported || !!boardLandingType}
				onResetToDefault={handleResetToDefault}
			/>

			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="object"
				defaultObjectSubtype={typeFilter}
			/>

			{effectiveView === 'board' && typeFilter ? (
				<div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-4">
					<BoardView
						objectType={typeFilter}
						clientFilter={hasClientFilter ? matchesClientFilters : undefined}
						columns={boardColumns}
						asksByObjectId={pendingAsksByObjectId}
						onAdvance={handleAdvanceStatus}
						boardParams={boardParams ?? {}}
						pageSize={BOARD_PAGE_SIZE}
						statusesByType={statusesByType}
						workspaceId={workspaceId}
						isLoading={boardQuery.isLoading}
						isError={boardQuery.isError}
						error={boardQuery.error}
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
				<ListView
					ref={listViewRef}
					data={listObjects}
					workspaceId={workspaceId}
					actors={actors}
					rowSelection={rowSelection}
					onRowSelectionChange={setRowSelection}
					columnVisibility={effectiveVisibility}
					grouping={groupingState}
					betStatuses={betStatuses}
					showBetStatusIndicator={showBetStatusIndicator}
					asksByObjectId={pendingAsksByObjectId}
					hasNextPage={infiniteQuery.hasNextPage}
					isFetchingNextPage={infiniteQuery.isFetchingNextPage}
					isError={infiniteQuery.isError}
					error={infiniteQuery.error}
					fetchNextPage={infiniteQuery.fetchNextPage}
					isLoading={infiniteQuery.isLoading}
					expanded={expanded}
					onExpandedChange={handleExpandedChange}
					onCaptureViewState={handleCaptureViewState}
					emptyTitle={filteredEmptyTitle}
					hasActiveFilters={hasAnyActiveFilter}
					onClearFilters={clearAllFilters}
					objectTypeLabel={objectTypeLabel}
				/>
			)}
			<BulkActionBar
				selectedCount={selectedIds.length}
				totalCount={selectableObjects.length}
				onSelectAll={handleSelectAll}
				onAskAgent={handleAskAgent}
				statusOptions={bulkStatusOptions}
				ownerOptions={bulkOwnerOptions}
				onStatusChange={handleBulkStatusChange}
				onOwnerChange={handleBulkOwnerChange}
				onCopyLink={handleCopyLinks}
				onCopyTitle={handleCopyTitles}
				onCopyTitleAsLink={handleCopyTitlesAsLinks}
				onOpenLinks={handleOpenLinks}
				onAnswerAsks={() => setAsksOpen(true)}
				askCount={askCount}
				// Archive is offered only where `Show archived` is — otherwise an
				// archived row leaves the list with no toggle to bring it back,
				// stranding it. Both gate on `supportsIncludeArchived` (bet-only
				// per T5) so the action and its escape hatch stay in lockstep.
				onArchive={supportsIncludeArchived ? handleBulkArchive : undefined}
				onDelete={handleBulkDelete}
				onClear={clearSelection}
			/>
			<AskPanel
				open={asksOpen}
				onOpenChange={setAsksOpen}
				title="Asks"
				subtitle={
					askCount > 0
						? `${askCount} agent${askCount === 1 ? '' : 's'} waiting on a decision`
						: undefined
				}
				asks={selectedAsks}
				actorsById={actorsById}
				onRespond={handleRespond}
			/>
		</div>
	)
}
