import { issueApiKey, validateApiKeyWithKind } from '@maskin/auth'
import { files, relationships } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { CONVERSATION_FILE_LINK_TYPE } from '../../lib/conversation-file-links'
import { recordEvent } from '../../lib/events/record-event'
import { insertConversationMessage } from '../../services/conversation-messages'
import { insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

async function insertFile(workspaceId: string, name = 'render.mp4') {
	const [row] = await db
		.insert(files)
		.values({
			workspaceId,
			name,
			mimeType: 'video/mp4',
			sizeBytes: 10,
			storageKey: `workspaces/${workspaceId}/files/${name}`,
			createdBy: getTestActorId(),
		})
		.returning()
	if (!row) throw new Error('file insert returned no row')
	return row
}

async function chatLinks(conversationId: string) {
	return db
		.select()
		.from(relationships)
		.where(
			and(
				eq(relationships.sourceId, conversationId),
				eq(relationships.type, CONVERSATION_FILE_LINK_TYPE),
			),
		)
}

describe('files an agent makes are linked to its chat', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	describe('file created by a session', () => {
		it('links the file to the chat the session runs in, once, however often it is written', async () => {
			const chat = await insertConversation(db, workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				conversationId: chat?.id,
			})
			const file = await insertFile(workspaceId)

			for (let i = 0; i < 2; i++) {
				await recordEvent(db, {
					workspaceId,
					actorId,
					action: 'created',
					entityType: 'file',
					entityId: file.id,
					provenance: { sessionId: session?.id, entityKind: 'file' },
				})
			}

			const rows = await chatLinks(chat?.id as string)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				sourceType: 'conversation',
				targetType: 'file',
				targetId: file.id,
			})
		})

		it('writes no chat link for a session that is not in a chat', async () => {
			const chat = await insertConversation(db, workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId)
			const file = await insertFile(workspaceId)

			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'file',
				entityId: file.id,
				provenance: { sessionId: session?.id, entityKind: 'file' },
			})

			expect(await chatLinks(chat?.id as string)).toHaveLength(0)
			const produced = await db
				.select()
				.from(relationships)
				.where(and(eq(relationships.targetId, file.id), eq(relationships.type, 'produced_by')))
			expect(produced).toHaveLength(1)
		})

		it('links no session chat when the caller opts out because it named a chat itself', async () => {
			const sessionChat = await insertConversation(db, workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				conversationId: sessionChat?.id,
			})
			const file = await insertFile(workspaceId)

			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'file',
				entityId: file.id,
				provenance: { sessionId: session?.id, entityKind: 'file', conversationId: null },
			})

			expect(await chatLinks(sessionChat?.id as string)).toHaveLength(0)
		})

		it('links no chat to a file that was deleted', async () => {
			const chat = await insertConversation(db, workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				conversationId: chat?.id,
			})
			const file = await insertFile(workspaceId)
			await db.delete(files).where(eq(files.id, file.id))

			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'deleted',
				entityType: 'file',
				entityId: file.id,
				provenance: { sessionId: session?.id, entityKind: 'file' },
			})

			expect(await chatLinks(chat?.id as string)).toHaveLength(0)
		})
	})

	describe('message from an agent session', () => {
		it('links the files named by URL in the text and by attachment, with the message id', async () => {
			const chat = await insertConversation(db, workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				conversationId: chat?.id,
			})
			const inText = await insertFile(workspaceId, 'preview.mp4')
			const attached = await insertFile(workspaceId, 'package.zip')

			const message = await insertConversationMessage(db, {
				conversationId: chat?.id as string,
				workspaceId,
				actorId,
				content: `Preview: https://maskin.io/${workspaceId}/files/${inText.id}`,
				metadata: { attachments: [{ file_id: attached.id }] },
				sessionId: session?.id as string,
			})

			const rows = await chatLinks(chat?.id as string)
			expect(rows.map((r) => r.targetId).sort()).toEqual([inText.id, attached.id].sort())
			for (const row of rows) {
				expect((row.metadata as { messageId?: number }).messageId).toBe(message?.id)
			}
		})

		it('skips files that are missing or belong to another workspace, and still posts', async () => {
			const chat = await insertConversation(db, workspaceId, actorId)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				conversationId: chat?.id,
			})
			const otherWorkspaceId = (await insertWorkspace(db, actorId)).id
			const foreign = await insertFile(otherWorkspaceId)

			const message = await insertConversationMessage(db, {
				conversationId: chat?.id as string,
				workspaceId,
				actorId,
				content: `See /files/${foreign.id} and /files/00000000-0000-4000-8000-000000000000`,
				metadata: null,
				sessionId: session?.id as string,
			})

			expect(message).not.toBeNull()
			expect(await chatLinks(chat?.id as string)).toHaveLength(0)
		})

		it('links nothing for a message that is not from a session', async () => {
			const chat = await insertConversation(db, workspaceId, actorId)
			const file = await insertFile(workspaceId)

			await insertConversationMessage(db, {
				conversationId: chat?.id as string,
				workspaceId,
				actorId,
				content: `Look at /files/${file.id}`,
				metadata: null,
				sessionId: null,
			})

			expect(await chatLinks(chat?.id as string)).toHaveLength(0)
		})
	})

	describe('session key', () => {
		it('names the session it was minted for; other keys name none', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId)

			const sessionKey = await issueApiKey(db, {
				actorId,
				kind: 'session',
				sessionId: session?.id,
			})
			const primaryKey = await issueApiKey(db, { actorId, kind: 'primary' })

			expect(await validateApiKeyWithKind(db, sessionKey.key)).toMatchObject({
				keyKind: 'session',
				sessionId: session?.id,
			})
			expect(await validateApiKeyWithKind(db, primaryKey.key)).toMatchObject({
				keyKind: 'primary',
				sessionId: null,
			})
		})
	})
})
