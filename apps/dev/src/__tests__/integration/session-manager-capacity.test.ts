import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

// Chat sessions (spawned from the Chat feature — conversationId set) are more
// urgent than background/trigger sessions: a human is waiting live. They must
// not consume, or be blocked by, the workspace's max_concurrent_sessions cap.
// See session-manager.ts hasCapacity() and the isChatSession bypass in startSession().
describe('SessionManager.hasCapacity — chat sessions excluded from workspace cap (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, {
			settings: { max_concurrent_sessions: 1 },
		})
		workspaceId = ws.id
	})

	it('does not count a running chat session toward the cap', async () => {
		const conversation = await insertConversation(db, workspaceId, actorId)
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			conversationId: conversation.id,
			interactive: true,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			const hasCapacity = await (
				manager as unknown as { hasCapacity(workspaceId: string): Promise<boolean> }
			).hasCapacity(workspaceId)

			expect(hasCapacity).toBe(true)
		} finally {
			await manager.stop()
		}
	})

	it('counts a running non-chat session toward the cap', async () => {
		await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })

		const manager = new SessionManager(db, stubStorage())
		try {
			const hasCapacity = await (
				manager as unknown as { hasCapacity(workspaceId: string): Promise<boolean> }
			).hasCapacity(workspaceId)

			expect(hasCapacity).toBe(false)
		} finally {
			await manager.stop()
		}
	})
})

describe('SessionManager.startSession — chat sessions bypass the workspace cap (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, {
			settings: { max_concurrent_sessions: 1 },
		})
		workspaceId = ws.id
	})

	it('queues a non-chat session when the workspace is already at capacity', async () => {
		await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })
		const pending = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			containerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.startSession(pending.id)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
		expect(row?.status).toBe('queued')
	})

	it('does not queue a chat session even when the workspace is already at capacity', async () => {
		const conversation = await insertConversation(db, workspaceId, actorId)
		await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })
		const chatSession = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			containerId: null,
			conversationId: conversation.id,
			interactive: true,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			// No real agent/Docker is set up in this test — the launch itself is
			// expected to fail past the capacity check, landing on 'failed'. The
			// assertion that matters is that it never sits at 'queued'.
			await manager.startSession(chatSession.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, chatSession.id))
		expect(row?.status).not.toBe('queued')
	})
})
