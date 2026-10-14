import type { Database, Transaction } from '@maskin/db'
import { conversations, files, objects, sessions, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

/**
 * A relationship endpoint id resolves to one of these kinds. This is the
 * canonical vocabulary any writer must stamp on the `sourceType`/`targetType`
 * column of a new `relationships` row. Slice 2 will widen this union with
 * `'conversation'` and `'session'` — every writer that consumes this helper
 * gains those two kinds for free, which is the reason the derivation lives in
 * one file rather than five.
 */
export type EndpointKind = 'object' | 'file'

/**
 * Resolve which kind each endpoint id belongs to. The rule is: an id present
 * in `files` for this workspace is `'file'`; anything else is `'object'`. We
 * never assert the id actually points at a row in `objects` — legacy writers
 * created edges before the schema learned to enforce that, and the read paths
 * are tolerant of a dangling endpoint (it just resolves to a `null` title).
 *
 * Batch-shape: one round-trip per call regardless of endpoint count. Callers
 * that already know a subset of ids are files/objects should still funnel
 * every candidate id through here so future kinds land in one place.
 */
export async function deriveEndpointKinds(
	db: Database | Transaction,
	workspaceId: string,
	endpointIds: readonly string[],
): Promise<Map<string, EndpointKind>> {
	const kinds = new Map<string, EndpointKind>()
	const unique = [...new Set(endpointIds)].filter((id) => id.length > 0)
	if (unique.length === 0) return kinds
	const fileRows = await db
		.select({ id: files.id })
		.from(files)
		.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, unique)))
	const fileIds = new Set(fileRows.map((r) => r.id))
	for (const id of unique) kinds.set(id, fileIds.has(id) ? 'file' : 'object')
	return kinds
}

/**
 * Convenience for the common single-pair write path. Prefer this over hand-
 * spelling `deriveEndpointKinds(...).then(m => [m.get(a), m.get(b)])` — the
 * types stay narrow and the default (`'object'`) matches the DB CHECK
 * constraint's oldest allowed value.
 */
export async function derivePairEndpointKinds(
	db: Database | Transaction,
	workspaceId: string,
	sourceId: string,
	targetId: string,
): Promise<{ sourceType: EndpointKind; targetType: EndpointKind }> {
	const kinds = await deriveEndpointKinds(db, workspaceId, [sourceId, targetId])
	return {
		sourceType: kinds.get(sourceId) ?? 'object',
		targetType: kinds.get(targetId) ?? 'object',
	}
}

/**
 * Which of these endpoint ids exist in the given workspace, as an object, a
 * file, a conversation, a session, a member actor, or the workspace itself
 * (onboarding writes `about` edges to the owner actor and to the workspace id).
 * Edge writers call this before touching `relationships`, which carries no
 * workspace column of its own: an id that is missing here either does not exist
 * or belongs to another workspace, and the caller answers 404 for both so
 * existence does not leak.
 *
 * Objects and files go first; the other kinds are only queried for the ids still
 * unresolved, so the common object-to-object edge costs two round-trips.
 */
export async function findEndpointIdsInWorkspace(
	db: Database | Transaction,
	workspaceId: string,
	endpointIds: readonly string[],
): Promise<Set<string>> {
	const found = new Set<string>()
	const unique = [...new Set(endpointIds)].filter((id) => id.length > 0)
	if (unique.length === 0) return found
	const [objectRows, fileRows] = await Promise.all([
		db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, unique))),
		db
			.select({ id: files.id })
			.from(files)
			.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, unique))),
	])
	for (const row of [...objectRows, ...fileRows]) found.add(row.id)
	if (unique.includes(workspaceId)) found.add(workspaceId)
	const remaining = unique.filter((id) => !found.has(id))
	if (remaining.length === 0) return found
	const [conversationRows, sessionRows, memberRows] = await Promise.all([
		db
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.workspaceId, workspaceId), inArray(conversations.id, remaining))),
		db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.id, remaining))),
		db
			.select({ id: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					inArray(workspaceMembers.actorId, remaining),
				),
			),
	])
	for (const row of [...conversationRows, ...sessionRows, ...memberRows]) found.add(row.id)
	return found
}
