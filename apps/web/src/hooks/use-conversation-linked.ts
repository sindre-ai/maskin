import { useFiles } from '@/hooks/use-files'
import { type MessageResponse, api } from '@/lib/api'
import { extractLinkedFileIds, extractLinkedObjectIds } from '@/lib/linked-objects'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

export interface LinkedItem {
	kind: 'object' | 'file'
	id: string
	/** The newest message that links to this item. */
	messageId: number
	actorId: string
	actorName: string
	actorType: 'human' | 'agent'
	createdAt: string | null
}

const ALL_LINKS = Number.MAX_SAFE_INTEGER

/**
 * The objects and files a conversation's messages link to, newest linking message first, one
 * entry per item (the newest message that links it wins). `messages` runs oldest first.
 */
export function deriveLinkedItems(messages: MessageResponse[], max = 100): LinkedItem[] {
	const items: LinkedItem[] = []
	const seen = new Set<string>()
	for (let i = messages.length - 1; i >= 0 && items.length < max; i--) {
		const message = messages[i]
		if (message.kind !== 'message' || !message.content) continue
		const found: Array<[LinkedItem['kind'], string]> = [
			...extractLinkedObjectIds(message.content, ALL_LINKS).map(
				(id): [LinkedItem['kind'], string] => ['object', id],
			),
			...extractLinkedFileIds(message.content, ALL_LINKS).map(
				(id): [LinkedItem['kind'], string] => ['file', id],
			),
		]
		for (const [kind, id] of found) {
			if (items.length >= max) break
			const key = `${kind}:${id}`
			if (seen.has(key)) continue
			seen.add(key)
			items.push({
				kind,
				id,
				messageId: message.id,
				actorId: message.actorId,
				actorName: message.actorName,
				actorType: message.actorType,
				createdAt: message.createdAt,
			})
		}
	}
	return items
}

export function useConversationLinked(messages: MessageResponse[]): LinkedItem[] {
	return useMemo(() => deriveLinkedItems(messages), [messages])
}

/**
 * Drops the items that turned out to be missing, errored or in another workspace, so the drawer
 * never shows a header over nothing. Items still loading stay (they draw a skeleton) but are
 * not counted: `count` is what the drawer will actually show.
 */
export function useResolvedLinkedItems(
	items: LinkedItem[],
	workspaceId: string,
): { items: LinkedItem[]; count: number } {
	const objectItems = useMemo(() => items.filter((i) => i.kind === 'object'), [items])
	const fileIds = useMemo(() => items.filter((i) => i.kind === 'file').map((i) => i.id), [items])
	const objects = useQueries({
		queries: objectItems.map((item) => ({
			queryKey: queryKeys.objects.detail(item.id),
			queryFn: () => api.objects.get(item.id),
		})),
	})
	const files = useFiles(workspaceId, { ids: fileIds })

	return useMemo(() => {
		const objectState = new Map<string, 'ok' | 'gone' | 'loading'>()
		objectItems.forEach((item, i) => {
			const q = objects[i]
			objectState.set(
				item.id,
				q?.isError || (q?.data && q.data.workspaceId !== workspaceId)
					? 'gone'
					: q?.data
						? 'ok'
						: 'loading',
			)
		})
		const knownFiles = files.data ? new Set(files.data.map((f) => f.id)) : null
		let count = 0
		const visible = items.filter((item) => {
			if (item.kind === 'object') {
				const state = objectState.get(item.id)
				if (state === 'ok') count++
				return state !== 'gone'
			}
			if (!knownFiles) return !files.isError
			const ok = knownFiles.has(item.id)
			if (ok) count++
			return ok
		})
		return { items: visible, count }
	}, [items, objectItems, objects, files.data, files.isError, workspaceId])
}
