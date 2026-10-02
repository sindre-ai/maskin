import { messages, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

describe('SessionManager.createSession — spawn anchor + deps (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let conversationId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const conversation = await insertConversation(db, workspaceId, actorId)
		conversationId = conversation.id
		// global-setup truncates sessions/events/etc. but NOT messages or
		// conversations — leave the conversation (no FK from it to the tables it
		// does truncate) and clear messages so ids stay unambiguous per test.
		await sql`TRUNCATE messages CASCADE`
	})

	async function insertMessage(content = 'in the loop'): Promise<number> {
		const [row] = await db
			.insert(messages)
			.values({ conversationId, actorId, content })
			.returning({ id: messages.id })
		if (!row) throw new Error('failed to insert message')
		return row.id
	}

	it('persists spawned_by_message_id and depends_on_session_ids from the caller-supplied values', async () => {
		const anchorMessageId = await insertMessage('spawn the sub-agent')
		const blockerId = crypto.randomUUID()

		const manager = new SessionManager(db, stubStorage())
		const created = await manager.createSession(workspaceId, {
			actorId,
			actionPrompt: 'do the thing',
			createdBy: actorId,
			autoStart: false,
			spawnedByMessageId: anchorMessageId,
			dependsOnSessionIds: [blockerId],
		})

		const [row] = await db
			.select({
				spawnedByMessageId: sessions.spawnedByMessageId,
				dependsOnSessionIds: sessions.dependsOnSessionIds,
			})
			.from(sessions)
			.where(eq(sessions.id, created.id))

		expect(row?.spawnedByMessageId).toBe(anchorMessageId)
		expect(row?.dependsOnSessionIds).toEqual([blockerId])
		expect(Array.isArray(row?.dependsOnSessionIds)).toBe(true)
	})

	it('writes NULL for both columns when the caller supplies neither', async () => {
		const manager = new SessionManager(db, stubStorage())
		const created = await manager.createSession(workspaceId, {
			actorId,
			actionPrompt: 'plain spawn',
			createdBy: actorId,
			autoStart: false,
		})

		const [row] = await db
			.select({
				spawnedByMessageId: sessions.spawnedByMessageId,
				dependsOnSessionIds: sessions.dependsOnSessionIds,
			})
			.from(sessions)
			.where(eq(sessions.id, created.id))

		expect(row?.spawnedByMessageId).toBeNull()
		expect(row?.dependsOnSessionIds).toBeNull()
	})

	it('keeps the session and nulls the anchor when the referenced message is deleted (ON DELETE SET NULL)', async () => {
		const anchorMessageId = await insertMessage('will be deleted')
		const manager = new SessionManager(db, stubStorage())
		const created = await manager.createSession(workspaceId, {
			actorId,
			actionPrompt: 'anchored spawn',
			createdBy: actorId,
			autoStart: false,
			spawnedByMessageId: anchorMessageId,
		})

		await db.delete(messages).where(eq(messages.id, anchorMessageId))

		const [row] = await db
			.select({
				id: sessions.id,
				spawnedByMessageId: sessions.spawnedByMessageId,
			})
			.from(sessions)
			.where(eq(sessions.id, created.id))

		// The session must survive — the anchor is a pointer, not ownership.
		expect(row).toBeDefined()
		expect(row?.id).toBe(created.id)
		expect(row?.spawnedByMessageId).toBeNull()
	})

	it('rejects a spawned_by_message_id that names no message (FK enforced)', async () => {
		const manager = new SessionManager(db, stubStorage())
		await expect(
			manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'bogus anchor',
				createdBy: actorId,
				autoStart: false,
				spawnedByMessageId: 999999999,
			}),
		).rejects.toThrow()
	})
})
