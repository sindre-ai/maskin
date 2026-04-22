import type { Database } from '@maskin/db'
import { events, notifications } from '@maskin/db/schema'
import { fetchParticipantActors } from './participants'

type NotifyParticipantsArgs = {
	workspaceId: string
	objectId: string
	sourceActorId: string
	/** Actor IDs to skip (typically the mutator). */
	exclude?: string[]
	title: string
	content?: string
	type?: string
	metadata?: Record<string, unknown>
}

/**
 * Create a notification for each assignee and watcher of an object, excluding any actor
 * in `exclude`. Also writes a `created` event per notification so SSE listeners refresh.
 */
export async function notifyParticipants(
	db: Database,
	args: NotifyParticipantsArgs,
): Promise<number> {
	const { assignees, watchers } = await fetchParticipantActors(db, args.objectId)
	const excluded = new Set(args.exclude ?? [])
	const targets = new Set<string>()
	for (const id of [...assignees, ...watchers]) {
		if (!excluded.has(id)) targets.add(id)
	}
	if (targets.size === 0) return 0

	const rows = [...targets].map((targetActorId) => ({
		workspaceId: args.workspaceId,
		type: args.type ?? 'alert',
		title: args.title,
		content: args.content,
		metadata: args.metadata,
		sourceActorId: args.sourceActorId,
		targetActorId,
		objectId: args.objectId,
		status: 'pending' as const,
	}))

	const created = await db.insert(notifications).values(rows).returning()

	if (created.length > 0) {
		await db.insert(events).values(
			created.map((n) => ({
				workspaceId: args.workspaceId,
				actorId: args.sourceActorId,
				action: 'created',
				entityType: 'notification',
				entityId: n.id,
				data: n,
			})),
		)
	}

	return created.length
}
