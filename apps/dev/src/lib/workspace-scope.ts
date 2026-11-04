import type { Database } from '@maskin/db'
import { conversations, objects, sessions, triggers, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'

/**
 * Raised when an id supplied by a caller does not belong to the workspace the
 * request runs in. An HTTPException with status 404, so both Hono's default
 * handler and app-factory's onError answer NOT_FOUND: a foreign id looks
 * exactly like one that does not exist.
 */
export class NotInWorkspaceError extends HTTPException {
	readonly kind: string

	constructor(kind: string) {
		super(404, { message: `${kind} not found` })
		this.name = 'NotInWorkspaceError'
		this.kind = kind
	}
}

type MaybeId = string | null | undefined

export interface WorkspaceRefs {
	/** Actor ids that must be members of the workspace. */
	actors?: MaybeId[]
	objects?: MaybeId[]
	conversations?: MaybeId[]
	triggers?: MaybeId[]
	sessions?: MaybeId[]
}

function uniqueIds(ids: MaybeId[] | undefined): string[] {
	return Array.from(new Set((ids ?? []).filter((id): id is string => !!id)))
}

/**
 * Throws NotInWorkspaceError unless every id in `refs` belongs to
 * `workspaceId`: actors by workspace membership, the rest by their own
 * workspace_id column. Empty and missing lists cost no query. Checked in a
 * fixed order (actors, objects, conversations, triggers, sessions).
 *
 * Use at the boundary where an id comes out of a request body or other
 * caller-supplied data, before anything is written or started with it.
 */
export async function assertInWorkspace(
	db: Database,
	workspaceId: string,
	refs: WorkspaceRefs,
): Promise<void> {
	const actorIds = uniqueIds(refs.actors)
	if (actorIds.length > 0) {
		const found = await db
			.select({ id: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					inArray(workspaceMembers.actorId, actorIds),
				),
			)
		if (found.length !== actorIds.length) throw new NotInWorkspaceError('Actor')
	}

	const objectIds = uniqueIds(refs.objects)
	if (objectIds.length > 0) {
		const found = await db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
		if (found.length !== objectIds.length) throw new NotInWorkspaceError('Object')
	}

	const conversationIds = uniqueIds(refs.conversations)
	if (conversationIds.length > 0) {
		const found = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(eq(conversations.workspaceId, workspaceId), inArray(conversations.id, conversationIds)),
			)
		if (found.length !== conversationIds.length) throw new NotInWorkspaceError('Conversation')
	}

	const triggerIds = uniqueIds(refs.triggers)
	if (triggerIds.length > 0) {
		const found = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(and(eq(triggers.workspaceId, workspaceId), inArray(triggers.id, triggerIds)))
		if (found.length !== triggerIds.length) throw new NotInWorkspaceError('Trigger')
	}

	const sessionIds = uniqueIds(refs.sessions)
	if (sessionIds.length > 0) {
		const found = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.id, sessionIds)))
		if (found.length !== sessionIds.length) throw new NotInWorkspaceError('Session')
	}
}
