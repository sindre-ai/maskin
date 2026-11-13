import type { Database, Transaction } from '@maskin/db'
import { conversations, files, relationships } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { logger } from './logger'
import { NotInWorkspaceError } from './workspace-scope'

/**
 * The link type from a chat to a file that belongs to it. Same direction as `spawned`
 * (chat first). Not `attached`: the web file viewer loads every source of an `attached`
 * link as a work item, so a chat id would fail there.
 */
export const CONVERSATION_FILE_LINK_TYPE = 'has_file'

// A file link in message text: the app's own URL for a file, `/files/<uuid>`.
const FILE_URL_RE = /\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

/** The distinct file ids that message text links to by URL. */
export function fileIdsInText(text: string): string[] {
	const ids = new Set<string>()
	for (const match of text.matchAll(FILE_URL_RE)) ids.add((match[1] as string).toLowerCase())
	return [...ids]
}

/**
 * Writes a `has_file` link from a chat to each of the given files. Insert only and idempotent on
 * (chat, file, type). A file that does not exist or sits in another workspace gets no link, and
 * so does a chat from another workspace. Ids are untrusted: a link must never point at a file
 * the workspace does not own. Never throws, because the file or message it hangs off is already
 * saved and a failed link must not undo it.
 */
export async function linkFilesToConversation(
	db: Database | Transaction,
	params: {
		workspaceId: string
		conversationId: string
		fileIds: string[]
		createdBy: string
		metadata?: Record<string, unknown>
	},
): Promise<number> {
	const fileIds = [...new Set(params.fileIds)]
	if (fileIds.length === 0) return 0
	try {
		const [conversation] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.id, params.conversationId),
					eq(conversations.workspaceId, params.workspaceId),
				),
			)
			.limit(1)
		if (!conversation) return 0

		const found = await db
			.select({ id: files.id })
			.from(files)
			.where(and(eq(files.workspaceId, params.workspaceId), inArray(files.id, fileIds)))
		if (found.length === 0) return 0

		const inserted = await db
			.insert(relationships)
			.values(
				found.map((f) => ({
					sourceType: 'conversation' as const,
					sourceId: params.conversationId,
					targetType: 'file' as const,
					targetId: f.id,
					type: CONVERSATION_FILE_LINK_TYPE,
					metadata: (params.metadata ?? null) as unknown as never,
					createdBy: params.createdBy,
				})),
			)
			.onConflictDoNothing({
				target: [relationships.sourceId, relationships.targetId, relationships.type],
			})
			.returning({ id: relationships.id })
		return inserted.length
	} catch (err) {
		logger.warn('chat-to-file link write failed', {
			workspaceId: params.workspaceId,
			conversationId: params.conversationId,
			error: err instanceof Error ? err.message : String(err),
		})
		return 0
	}
}

/**
 * The action prompt with a list of the files handed to the session, by name and id. Files that
 * do not exist in the workspace are an error: a helper told about a file it cannot fetch would
 * only go looking for it. Returns the prompt as it was when no file is given.
 */
export async function withHandedFiles(
	db: Database,
	params: { workspaceId: string; actionPrompt: string; fileIds: string[] | undefined },
): Promise<string> {
	const fileIds = [...new Set(params.fileIds ?? [])]
	if (fileIds.length === 0) return params.actionPrompt
	const found = await db
		.select({ id: files.id, name: files.name, mimeType: files.mimeType })
		.from(files)
		.where(and(eq(files.workspaceId, params.workspaceId), inArray(files.id, fileIds)))
	if (found.length !== fileIds.length) throw new NotInWorkspaceError('File')
	const lines = found.map((f) => `- ${f.name} (${f.mimeType}) — file id: ${f.id}`)
	return `${params.actionPrompt}\n\nFiles handed to you (call the get_file MCP tool with the file id to read the content):\n${lines.join('\n')}`
}
