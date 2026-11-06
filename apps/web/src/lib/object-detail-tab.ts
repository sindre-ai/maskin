/** The item page's tabs (v16): one column, three tabs. `?tab=related` opens one directly. */
export const OBJECT_DETAIL_TABS = ['overview', 'related', 'activity'] as const
export type ObjectDetailTab = (typeof OBJECT_DETAIL_TABS)[number]

/** Anything that is not a known tab is the Overview, so a stale link never lands on a blank page. */
export function parseObjectDetailTab(value: unknown): ObjectDetailTab | undefined {
	return typeof value === 'string' && (OBJECT_DETAIL_TABS as readonly string[]).includes(value)
		? (value as ObjectDetailTab)
		: undefined
}
