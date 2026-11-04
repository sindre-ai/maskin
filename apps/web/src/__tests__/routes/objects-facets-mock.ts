import type { ObjectFacetsResponse } from '@maskin/shared'
import { vi } from 'vitest'

// Stand-ins for the facets / grouped-rows hooks the Objects route reads, for the
// route tests that replace `@/hooks/use-objects` wholesale. `facetsState` is what
// the server's totals would be; a test sets `facetsState.data` before rendering.
export const facetsState: {
	data: ObjectFacetsResponse | undefined
	isLoading: boolean
} = { data: undefined, isLoading: false }

export function resetFacetsState() {
	facetsState.data = undefined
	facetsState.isLoading = false
}

export function buildFacets(overrides: Partial<ObjectFacetsResponse> = {}): ObjectFacetsResponse {
	return {
		total: 0,
		by_type: {},
		by_status: {},
		by_driver: {},
		updated: {},
		fresh: 0,
		starred: 0,
		working: 0,
		waiting: 0,
		groups: [],
		...overrides,
	}
}

export const facetHookMocks = {
	GROUP_PAGE_SIZE: 25,
	useObjectFacets: () => ({
		data: facetsState.data,
		isLoading: facetsState.isLoading,
		isError: false,
		error: null,
	}),
	useGroupedObjects: () => ({
		rows: [],
		groups: [],
		loadingGroups: new Set<string>(),
		hasMoreGroups: false,
		loadMoreInGroup: vi.fn(),
		loadMoreGroups: vi.fn(),
		isLoading: false,
		error: null,
	}),
}
