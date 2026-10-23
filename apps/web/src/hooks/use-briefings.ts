import { useActors } from '@/hooks/use-actors'
import { api } from '@/lib/api'
import { briefingHeadline, pickBriefingPages } from '@/lib/briefing-stories'
import { decodeBase64Utf8 } from '@/lib/file-utils'
import { queryKeys } from '@/lib/query-keys'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

export interface BriefingCard {
	id: string
	name: string
	headline: string
	/** Who wrote the page: the Chief of Staff for the daily briefing, else the loop's agent. */
	author: { id: string | null; name: string; type: string }
	updatedAt: string
	/** The page's HTML; undefined while its file is still loading. */
	html: string | undefined
}

/**
 * The For you briefing cards: every HTML file marked `kind: "briefing"`, newest
 * first. The list endpoint carries no content, and a card's title lives in the
 * page itself, so each page is fetched (cached under the shared file-detail key,
 * so opening it in the viewer costs nothing more). A page that hasn't arrived yet
 * is left out of the row rather than shown under its file name.
 */
export function useBriefings(workspaceId: string) {
	const list = useQuery({
		queryKey: [...queryKeys.files.all(workspaceId), 'briefings'],
		queryFn: () => api.files.list(workspaceId, { kind: 'briefing', limit: 24 }),
		enabled: !!workspaceId,
	})
	const { data: actors } = useActors(workspaceId)

	const pages = useMemo(() => pickBriefingPages(list.data ?? []), [list.data])

	const details = useQueries({
		queries: pages.map((file) => ({
			queryKey: queryKeys.files.detail(workspaceId, file.id),
			queryFn: () => api.files.get(workspaceId, file.id),
			// A briefing is written once a day; the SSE file events invalidate it when it changes.
			staleTime: 60_000,
		})),
	})

	const cards = useMemo<BriefingCard[]>(() => {
		const result: BriefingCard[] = []
		pages.forEach((file, index) => {
			const detail = details[index]?.data
			if (!detail) return
			const html = detail.encoding === 'utf8' ? detail.content : decodeBase64Utf8(detail.content)
			const author = actors?.find((actor) => actor.id === file.createdBy)
			result.push({
				id: file.id,
				name: file.name,
				headline: briefingHeadline(html, file.name),
				author: {
					id: author?.id ?? null,
					name: author?.name ?? 'Chief of Staff',
					type: author?.type ?? 'agent',
				},
				updatedAt: file.updatedAt,
				html,
			})
		})
		return result
	}, [pages, details, actors])

	return { cards, isLoading: list.isLoading, isError: list.isError }
}
