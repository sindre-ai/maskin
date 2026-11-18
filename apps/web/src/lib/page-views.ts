import { viewTabValue } from '@/lib/object-detail-tab'
import { type LoopView, readLoopViews, toLoopViewsMetadata } from '@maskin/shared'

// Custom views on the Items list live in workspace settings, one list per object type, in the
// same { name, file_id } shape a flow keeps in metadata.views. References only, never copies.
export const LIST_VIEWS_SETTINGS_KEY = 'list_views'
/** The key for the Items list with no type picked. */
export const LIST_VIEWS_ALL_KEY = 'all'

function readMap(settings: Record<string, unknown> | null | undefined): Record<string, unknown> {
	const raw = settings?.[LIST_VIEWS_SETTINGS_KEY]
	return raw && typeof raw === 'object' && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {}
}

/** The views on the Items list for one object type, in tab order. Anything malformed reads as none. */
export function readListViews(
	settings: Record<string, unknown> | null | undefined,
	type: string | undefined,
): LoopView[] {
	return readLoopViews({ views: readMap(settings)[type ?? LIST_VIEWS_ALL_KEY] })
}

/**
 * The settings patch that sets one type's views. The server replaces a top-level settings key
 * wholesale, so the other types' lists are carried over from `settings`, which must be fresh.
 */
export function listViewsSettingsPatch(
	settings: Record<string, unknown> | null | undefined,
	type: string | undefined,
	views: LoopView[],
): Record<string, unknown> {
	const next = { ...readMap(settings) }
	const key = type ?? LIST_VIEWS_ALL_KEY
	if (views.length === 0) delete next[key]
	else next[key] = toLoopViewsMetadata(views)
	return { [LIST_VIEWS_SETTINGS_KEY]: next }
}

/** A view with the value its tab carries, `view-0` for the first: the same naming a flow's tabs use. */
export type ViewTab = LoopView & { value: string }

/** The tab row for a list or an item page: the views in order, each with its tab value. */
export function viewTabs(views: LoopView[]): ViewTab[] {
	return views.map((view, i) => ({ ...view, value: viewTabValue(i) }))
}

/** The views stored on an item (`metadata.views`) as tabs. None when the feature is off. */
export function objectViewTabs(
	metadata: Record<string, unknown> | null | undefined,
	enabled: boolean,
): ViewTab[] {
	return enabled ? viewTabs(readLoopViews(metadata)) : []
}
