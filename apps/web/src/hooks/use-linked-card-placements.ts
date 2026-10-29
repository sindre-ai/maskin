import { api } from '@/lib/api'
import {
	type CardMessage,
	type DraftHistory,
	type MessagePlacement,
	decideLinkedPlacements,
	editTimes,
	idsLinkedMoreThanOnce,
} from '@/lib/linked-card-holders'
import { hasPreviewCard } from '@/lib/linked-objects'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

const HISTORY_LIMIT = '50'

/**
 * For each message, which linked objects it draws as a chip because another message holds the
 * card, and which draft cards carry an Updated tag (see `decideLinkedPlacements`).
 *
 * Only ids linked by more than one message are looked at. Their objects are the ones the cards
 * already fetch (same query), and the edit history is fetched only for the drafts among them.
 * Both are reduced to plain values inside `combine`, so the result keeps its identity until
 * something really changes and the messages are not parsed again on every render.
 */
export function useLinkedCardPlacements(
	workspaceId: string,
	messages: readonly CardMessage[],
): ReadonlyMap<number, MessagePlacement> {
	const repeated = useMemo(() => idsLinkedMoreThanOnce(messages), [messages])

	const draftIds = useQueries({
		queries: repeated.map((id) => ({
			queryKey: queryKeys.objects.detail(id),
			queryFn: () => api.objects.get(id),
		})),
		combine: (results) => repeated.filter((_id, i) => hasPreviewCard(results[i]?.data)),
	})

	const histories = useQueries({
		queries: draftIds.map((id) => ({
			queryKey: queryKeys.events.byEntity(id),
			queryFn: () => api.events.history(workspaceId, { entity_id: id, limit: HISTORY_LIMIT }),
		})),
		combine: (results): Record<string, DraftHistory> =>
			Object.fromEntries(
				draftIds.map((id, i): [string, DraftHistory] => {
					const result = results[i]
					if (result?.data) return [id, { state: 'ready', editedAt: editTimes(result.data) }]
					return [id, { state: result?.isError ? 'failed' : 'loading' }]
				}),
			),
	})

	return useMemo(
		() =>
			decideLinkedPlacements(
				messages,
				(id) => draftIds.includes(id),
				(id) => histories[id] ?? { state: 'loading' },
			),
		[messages, draftIds, histories],
	)
}
