/** The item page's tabs (v16): one column, three tabs. `?tab=related` opens one directly. */
export const OBJECT_DETAIL_TABS = ['overview', 'related', 'activity'] as const
export type BuiltInObjectDetailTab = (typeof OBJECT_DETAIL_TABS)[number]
/** A custom view on the item, by its place in `metadata.views` (`view-0` is the first). */
export type ObjectViewTab = `view-${number}`
export type ObjectDetailTab = BuiltInObjectDetailTab | ObjectViewTab

const VIEW_TAB_RE = /^view-\d+$/

export function viewTabValue(index: number): ObjectViewTab {
	return `view-${index}`
}

/**
 * Anything that is not a known tab is the Overview, so a stale link never lands on a blank page.
 * A view tab parses by its shape; whether the item has that view is the page's call.
 */
export function parseObjectDetailTab(value: unknown): ObjectDetailTab | undefined {
	if (typeof value !== 'string') return undefined
	if ((OBJECT_DETAIL_TABS as readonly string[]).includes(value)) return value as ObjectDetailTab
	return VIEW_TAB_RE.test(value) ? (value as ObjectViewTab) : undefined
}
