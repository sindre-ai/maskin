import {
	type NarrativeFallbackInput,
	buildFallbackHeadline,
} from '@/components/dashboard/narrative-fallback'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import type { HeadlineResponse } from '@maskin/shared'
import { useQuery } from '@tanstack/react-query'

const FIVE_MINUTES_MS = 5 * 60 * 1000

/**
 * Fetch the workspace headline (LLM with rule-based fallback) and *always*
 * return a usable `headline` value — even while loading or after a network
 * error. The strip is the most important pixel on the dashboard and must
 * never appear blank.
 *
 * The local fallback mirrors the backend's `buildFallbackHeadline` so the
 * sentence is consistent before and after the LLM-backed response arrives.
 */
export function useDashboardHeadline(workspaceId: string, fallbackInput: NarrativeFallbackInput) {
	const query = useQuery<HeadlineResponse>({
		queryKey: queryKeys.dashboard.headline(workspaceId),
		queryFn: () => api.workspaces.headline(workspaceId),
		staleTime: FIVE_MINUTES_MS,
		enabled: !!workspaceId,
	})

	const fallbackHeadline = buildFallbackHeadline(fallbackInput)

	const headline: HeadlineResponse = query.data ?? {
		headline: fallbackHeadline,
		generatedAt: new Date(0).toISOString(),
		source: 'fallback',
	}

	return {
		headline,
		isLoading: query.isLoading,
		isError: query.isError,
	}
}
