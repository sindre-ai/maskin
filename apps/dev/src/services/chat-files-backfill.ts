import type { Database } from '@maskin/db'
import { conversations, files, messages, relationships } from '@maskin/db/schema'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'

/**
 * One-off backfill of the `conversation -> file` `has_file` edges for messages stored before the
 * live writer (linkFilesToConversation) existed. Run by scripts/backfill-chat-attached-files.ts after
 * deploy, a dry run first.
 *
 * The relationships table has no foreign key on either end, so nothing in the database stops a
 * wrong link; the rules live here:
 * - Insert only, ON CONFLICT DO NOTHING on (source, target, type). Re-running adds zero rows.
 * - An attachment whose file does not exist, or lives in another workspace than the chat, or whose
 *   id is not a UUID, is skipped and counted. Attachment ids are client-supplied.
 * - The edge is credited to the message author and carries the message id. Messages are read
 *   oldest first, so a file attached twice in a chat keeps its earliest message.
 * - Deleted messages have no metadata and produce nothing.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ChatFilesBackfillCounts {
	messagesScanned: number
	/** Links written; with `apply` false, the links that would be written. */
	linksAdded: number
	alreadyLinked: number
	skippedMissing: number
	skippedOtherWorkspace: number
	skippedBadId: number
}

export interface ChatFilesBackfillOptions {
	/** Write the links. Without it nothing is written and `linksAdded` is the count to add. */
	apply: boolean
	workspaceId?: string
	/** Messages read per round. */
	batchSize?: number
	onBatch?: (counts: ChatFilesBackfillCounts) => void
}

type Candidate = {
	conversationId: string
	workspaceId: string
	fileId: string
	messageId: number
	actorId: string
}

export async function backfillChatAttachedFiles(
	db: Database,
	opts: ChatFilesBackfillOptions,
): Promise<ChatFilesBackfillCounts> {
	const batchSize = opts.batchSize ?? 500
	const counts: ChatFilesBackfillCounts = {
		messagesScanned: 0,
		linksAdded: 0,
		alreadyLinked: 0,
		skippedMissing: 0,
		skippedOtherWorkspace: 0,
		skippedBadId: 0,
	}
	let lastId = 0

	for (;;) {
		const rows = await db
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				actorId: messages.actorId,
				metadata: messages.metadata,
				workspaceId: conversations.workspaceId,
			})
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.where(
				and(
					gt(messages.id, lastId),
					eq(messages.kind, 'message'),
					sql`${messages.deletedAt} IS NULL`,
					// One CASE, not two ANDed conditions: Postgres may evaluate the length call before the
					// type check and fail the whole statement on a row whose attachments is not a list.
					sql`CASE WHEN jsonb_typeof(${messages.metadata} -> 'attachments') = 'array' THEN jsonb_array_length(${messages.metadata} -> 'attachments') > 0 ELSE false END`,
					...(opts.workspaceId ? [eq(conversations.workspaceId, opts.workspaceId)] : []),
				),
			)
			.orderBy(asc(messages.id))
			.limit(batchSize)
		if (rows.length === 0) break
		lastId = rows[rows.length - 1]?.id ?? lastId
		counts.messagesScanned += rows.length

		const wellFormed: Candidate[] = []
		for (const row of rows) {
			const list = (row.metadata as { attachments?: Array<{ file_id?: unknown }> } | null)
				?.attachments
			for (const a of list ?? []) {
				if (typeof a?.file_id !== 'string' || !UUID_RE.test(a.file_id)) {
					counts.skippedBadId++
					continue
				}
				wellFormed.push({
					conversationId: row.conversationId,
					workspaceId: row.workspaceId,
					fileId: a.file_id.toLowerCase(),
					messageId: row.id,
					actorId: row.actorId,
				})
			}
		}

		const ids = [...new Set(wellFormed.map((c) => c.fileId))]
		const owners = new Map<string, string>()
		if (ids.length > 0) {
			const found = await db
				.select({ id: files.id, workspaceId: files.workspaceId })
				.from(files)
				.where(inArray(files.id, ids))
			for (const f of found) owners.set(f.id, f.workspaceId)
		}

		const seen = new Set<string>()
		const ok: Candidate[] = []
		for (const c of wellFormed) {
			const owner = owners.get(c.fileId)
			if (owner === undefined) counts.skippedMissing++
			else if (owner !== c.workspaceId) counts.skippedOtherWorkspace++
			else if (!seen.has(`${c.conversationId}:${c.fileId}`)) {
				seen.add(`${c.conversationId}:${c.fileId}`)
				ok.push(c)
			}
		}

		if (ok.length > 0) {
			if (opts.apply) {
				const inserted = await db
					.insert(relationships)
					.values(
						ok.map((c) => ({
							sourceType: 'conversation',
							sourceId: c.conversationId,
							targetType: 'file',
							targetId: c.fileId,
							type: 'has_file',
							metadata: { messageId: c.messageId } as unknown as never,
							createdBy: c.actorId,
						})),
					)
					.onConflictDoNothing({
						target: [relationships.sourceId, relationships.targetId, relationships.type],
					})
					.returning({ id: relationships.id })
				counts.linksAdded += inserted.length
				counts.alreadyLinked += ok.length - inserted.length
			} else {
				const existing = await db
					.select({ sourceId: relationships.sourceId, targetId: relationships.targetId })
					.from(relationships)
					.where(
						and(
							eq(relationships.type, 'has_file'),
							inArray(relationships.sourceId, [...new Set(ok.map((c) => c.conversationId))]),
							inArray(relationships.targetId, [...new Set(ok.map((c) => c.fileId))]),
						),
					)
				const have = new Set(existing.map((e) => `${e.sourceId}:${e.targetId}`))
				const fresh = ok.filter((c) => !have.has(`${c.conversationId}:${c.fileId}`))
				counts.linksAdded += fresh.length
				counts.alreadyLinked += ok.length - fresh.length
			}
		}
		opts.onBatch?.(counts)
	}
	return counts
}
