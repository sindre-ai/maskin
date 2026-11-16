import { api } from '@/lib/api'
import { canStillApproveDraft, extractLinkedObjectIds } from '@/lib/linked-objects'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'

/**
 * Whether a message links a draft that still has its own Approve card, so a question asked in the
 * same message is not drawn beside it. A draft whose card sits in another message (`skipIds`) is
 * only a chip here and does not count. Shares the object cache with the cards themselves.
 */
export function useLinksApprovableDraft(
	content: string,
	workspaceId: string,
	skipIds?: ReadonlySet<string>,
): boolean {
	const ids = extractLinkedObjectIds(content).filter((id) => !skipIds?.has(id))
	const objects = useQueries({
		queries: ids.map((id) => ({
			queryKey: queryKeys.objects.detail(id),
			queryFn: () => api.objects.get(id),
		})),
	})
	return objects.some((q) => canStillApproveDraft(q.data, workspaceId))
}
