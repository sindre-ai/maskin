import type { DisplaySettingsBody } from '@/lib/api'
import type { VisibilityState } from '@tanstack/react-table'

// The shared filter model for the Objects page's two view modes (List + Board).
//
// One object holds every axis of filter/group/order/show state:
//   - filter: type, status, driver, metadata, ids
//   - order: sort, order
//   - group: groupBy
//   - show-in-list: columnVisibility
//   - show-archived: includeArchived
//
// Both views derive their API params from the SAME model instance via
// `toListParams` and `toBoardParams`, so List <-> Board parity is structural by
// construction: a filter set once cannot reach one view without the other.
// The page owns the source of each field (URL search params for filters/order/
// group/archived, local state for show-in-list), materializes it into a model
// with `fromUrlSearch`, and feeds every consumer through that one object.
//
// `view` (list|board) is deliberately NOT part of the model — it is a display
// mode, route-local, and has its own slot in persisted DisplaySettings.

export interface ObjectsFilterModel {
	type?: string
	status?: string
	driver?: string
	metadata: Record<string, string>
	ids?: string
	groupBy?: string
	sort: string
	order: 'asc' | 'desc'
	includeArchived: boolean
	q?: string
	columnVisibility?: VisibilityState
}

// Shape accepted by `fromUrlSearch`. Mirrors the route's `validateSearch`
// output plus the local `columnVisibility` state. All fields optional so the
// page can feed it straight from destructured search params.
export interface ObjectsFilterModelInput {
	type?: string
	status?: string
	driver?: string
	sort?: string
	order?: 'asc' | 'desc'
	q?: string
	groupBy?: string
	ids?: string
	includeArchived?: boolean
	metadata?: Record<string, string>
	columnVisibility?: VisibilityState
}

export const DEFAULT_SORT = 'createdAt'
export const DEFAULT_ORDER = 'desc'

export function defaultObjectsFilterModel(): ObjectsFilterModel {
	return { sort: DEFAULT_SORT, order: DEFAULT_ORDER, metadata: {}, includeArchived: false }
}

export function fromUrlSearch(search: ObjectsFilterModelInput): ObjectsFilterModel {
	return {
		type: search.type,
		status: search.status,
		driver: search.driver,
		q: search.q,
		groupBy: search.groupBy,
		ids: search.ids,
		sort: search.sort ?? DEFAULT_SORT,
		order: search.order ?? DEFAULT_ORDER,
		includeArchived: search.includeArchived ?? false,
		metadata: { ...(search.metadata ?? {}) },
		columnVisibility: search.columnVisibility,
	}
}

export interface ListParamsOptions {
	/** Bet-only per T5: when false, never emits `include_archived` even if the
	 * model has it set, so non-bet tabs keep the API's default (hide archived). */
	includeArchivedAllowed?: boolean
}

// API params for the List (infinite table) query. `q` is intentionally absent —
// the page routes it to the search endpoint separately in its queryFn.
export function toListParams(
	model: ObjectsFilterModel,
	options: ListParamsOptions = {},
): Record<string, string> {
	const params: Record<string, string> = {}
	if (model.type) params.type = model.type
	if (model.status) params.status = model.status
	if (model.driver) params.driver = model.driver
	if (model.ids) params.ids = model.ids
	for (const [field, value] of Object.entries(model.metadata)) {
		params[`metadata.${field}`] = value
	}
	params.sort = model.sort
	params.order = model.order
	if (model.includeArchived && options.includeArchivedAllowed !== false) {
		params.include_archived = 'true'
	}
	return params
}

export interface BoardParamsConfig extends ListParamsOptions {
	pageSize: number
	offset?: string
}

// API params for the Board query. Everything List sends (so a filter set in
// List applies identically here) plus paging, and `q` / `groupBy` when set.
// The board endpoint requires a single object type, so it returns null without
// one — callers gate the query on that.
export function toBoardParams(
	model: ObjectsFilterModel,
	config: BoardParamsConfig,
): Record<string, string> | null {
	if (!model.type) return null
	const params: Record<string, string> = {
		...toListParams(model, config),
		limit: String(config.pageSize),
		offset: config.offset ?? '0',
	}
	if (model.q) params.q = model.q
	if (model.groupBy) params.groupBy = model.groupBy
	return params
}

// The DisplaySettings persistence blob for the model's filter/order/group and
// show-in-list axes. `view` and the cross-session group-expansion/scroll-anchor
// fields are page state, so the page spreads this result and adds those itself.
// `filters` is omitted when empty — the strict schema allows it absent.
export function toDisplaySettingsBody(
	model: ObjectsFilterModel,
): Pick<DisplaySettingsBody, 'sort' | 'order' | 'groupBy' | 'filters' | 'columnVisibility'> {
	const body: Pick<
		DisplaySettingsBody,
		'sort' | 'order' | 'groupBy' | 'filters' | 'columnVisibility'
	> = {
		sort: model.sort,
		order: model.order,
		groupBy: model.groupBy ?? null,
		columnVisibility: model.columnVisibility,
	}
	const filters: { status?: string; driver?: string; metadata?: Record<string, string> } = {}
	if (model.status) filters.status = model.status
	if (model.driver) filters.driver = model.driver
	if (Object.keys(model.metadata).length > 0) filters.metadata = model.metadata
	if (filters.status || filters.driver || filters.metadata) body.filters = filters
	return body
}
