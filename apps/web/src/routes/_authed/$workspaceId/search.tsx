import { SearchRoute } from '@/components/legacy/search-view'
import { SearchPageV2 } from '@/components/search/search-page'
import { SEARCH_GROUPS } from '@/hooks/legacy/use-workspace-search'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { createFileRoute } from '@tanstack/react-router'

const GROUP_VALUES = new Set<string>(SEARCH_GROUPS)

// q, type, status and group are the params the old page reads. types, statuses, updated
// and sort are the v2 page's. Both sets are accepted here, outside the flag boundary, so
// an old link still opens the old page and a new link survives a flag switch.
export interface SearchParams {
	q?: string
	type?: string
	status?: string
	group?: string
	types?: string
	statuses?: string
	updated?: string
	sort?: string
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)

export const Route = createFileRoute('/_authed/$workspaceId/search')({
	component: SearchRouteGate,
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		q: optionalString(search.q),
		type: optionalString(search.type),
		status: optionalString(search.status),
		group:
			typeof search.group === 'string' && GROUP_VALUES.has(search.group) ? search.group : undefined,
		types: optionalString(search.types),
		statuses: optionalString(search.statuses),
		updated: optionalString(search.updated),
		sort: optionalString(search.sort),
	}),
})

// The one read of the search-v2 flag: flag on swaps in the v2 page, off keeps the old one.
function SearchRouteGate() {
	const searchV2 = useFeatureFlag('search-v2')
	return searchV2 ? <SearchPageV2 /> : <SearchRoute />
}
