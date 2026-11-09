import { SearchPageV2 } from '@/components/search/search-page'
import { createFileRoute } from '@tanstack/react-router'

// q, types, statuses, participants, updated and sort are the params the search page reads.
export interface SearchParams {
	q?: string
	types?: string
	statuses?: string
	participants?: string
	updated?: string
	sort?: string
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)

export const Route = createFileRoute('/_authed/$workspaceId/search')({
	component: SearchPageV2,
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		q: optionalString(search.q),
		types: optionalString(search.types),
		statuses: optionalString(search.statuses),
		participants: optionalString(search.participants),
		updated: optionalString(search.updated),
		sort: optionalString(search.sort),
	}),
})
