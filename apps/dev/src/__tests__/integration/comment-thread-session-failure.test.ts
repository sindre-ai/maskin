/**
 * Failure-path coverage for comment-thread agent sessions, against real
 * Postgres. Both behaviours here decide whether a human's comment is silently
 * dropped, and neither is observable through a mocked DB: one turns on the
 * exact status the frontend keys its "interrupted" notice off, the other on a
 * DELETE ... RETURNING against comment_pending_turns.
 */
import { events, commentPendingTurns, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertObject, insertSession, insertSessionLog, insertWorkspace } from '../factories'
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

describe('Comment-thread session failure paths (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let objectId: string
	let threadRootEventId: number

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const obj = await insertObject(db, workspaceId, actorId)
		objectId = obj.id
		const [root] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: '@agent can you look at this?' },
			})
			.returning()
		if (!root) throw new Error('failed to insert thread root comment')
		threadRootEventId = root.id
	})

	function insertThreadSession(overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			interactive: true,
			commentThreadRootEventId: threadRootEventId,
			config: {
				interactive: true,
				comment_thread: {
					object_id: objectId,
					thread_root_event_id: threadRootEventId,
				},
			},
			containerId: null,
			...overrides,
		})
	}

	async function runWatchdog(manager: SessionManager) {
		await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
	}

	describe('hasUnansweredConversationTurn() — comment-thread branch', () => {
		it('closes a session that never received its seed turn as timeout, not completed', async () => {
			// The seed-turn-never-landed failure from known-pitfalls.md: the
			// container booted and nothing was ever written to its stdin, so there
			// is no `maskin_message_id` row at all. Closing this as `completed`
			// would hide the dropped comment behind a green checkmark.
			const session = await insertThreadSession({
				startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
				timeoutAt: new Date(Date.now() - 60 * 1000),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await runWatchdog(manager)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('timeout')
		})

		it('closes a session whose last delivered turn was answered as completed', async () => {
			// Silence is a designed outcome for a declined turn, but the CLI still
			// emits a `result` envelope — a result newer than the last delivered
			// turn means nothing is owed.
			const session = await insertThreadSession({
				startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
				timeoutAt: new Date(Date.now() - 60 * 1000),
			})
			await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: JSON.stringify({ type: 'user', maskin_message_id: threadRootEventId }),
			})
			await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: JSON.stringify({ type: 'result', subtype: 'success' }),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await runWatchdog(manager)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
		})

		it('closes a session with a delivered turn and no result as timeout', async () => {
			const session = await insertThreadSession({
				startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
				timeoutAt: new Date(Date.now() - 60 * 1000),
			})
			await insertSessionLog(db, session.id, {
				stream: 'stdout',
				content: JSON.stringify({ type: 'user', maskin_message_id: threadRootEventId }),
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await runWatchdog(manager)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('timeout')
		})
	})

	describe('releaseBufferedCommentTurnsOnBootFailure()', () => {
		async function release(manager: SessionManager, sessionId: string, reason: string) {
			const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
			await (
				manager as unknown as {
					releaseBufferedCommentTurnsOnBootFailure(s: unknown, r: string): Promise<void>
				}
			).releaseBufferedCommentTurnsOnBootFailure(row, reason)
		}

		it('discards stranded turns and posts a threaded comment saying so', async () => {
			// A session that fails before reaching `running` never runs the
			// post-boot drain, so without this the rows sit in the table forever
			// and the human waits for a reply that no code path will ever send.
			const session = await insertThreadSession({ status: 'failed' })
			const [second] = await db
				.insert(events)
				.values({
					workspaceId,
					actorId,
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'any update?', parentEventId: threadRootEventId },
				})
				.returning()
			if (!second) throw new Error('failed to insert follow-up comment')
			for (const commentEventId of [threadRootEventId, second.id]) {
				await db.insert(commentPendingTurns).values({
					threadRootEventId,
					actorId,
					commentEventId,
					payload: { type: 'user', message: { role: 'user', content: 'buffered' } },
				})
			}

			const manager = new SessionManager(db, stubStorage())
			try {
				await release(manager, session.id, 'Enqueue failed: no capacity')
			} finally {
				await manager.stop()
			}

			const remaining = await db
				.select()
				.from(commentPendingTurns)
				.where(eq(commentPendingTurns.threadRootEventId, threadRootEventId))
			expect(remaining).toHaveLength(0)

			const comments = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			const posted = comments.filter(
				(c) => (c.data as { parentEventId?: number })?.parentEventId === threadRootEventId,
			)
			// The follow-up comment plus the agent's "I couldn't start" notice.
			expect(posted).toHaveLength(2)
			const notice = posted.find((c) => c.actorId === actorId && c.id !== second.id)
			expect((notice?.data as { content?: string })?.content).toContain('2 comments')
		})

		it('posts nothing when there were no buffered turns to strand', async () => {
			const session = await insertThreadSession({ status: 'failed' })

			const manager = new SessionManager(db, stubStorage())
			try {
				await release(manager, session.id, 'boom')
			} finally {
				await manager.stop()
			}

			const comments = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			expect(comments).toHaveLength(1)
		})

		it('is a no-op for a session that is not a comment-thread session', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'failed',
				interactive: true,
			})
			await db.insert(commentPendingTurns).values({
				threadRootEventId,
				actorId,
				commentEventId: threadRootEventId,
				payload: { type: 'user', message: { role: 'user', content: 'buffered' } },
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await release(manager, session.id, 'boom')
			} finally {
				await manager.stop()
			}

			const remaining = await db
				.select()
				.from(commentPendingTurns)
				.where(eq(commentPendingTurns.threadRootEventId, threadRootEventId))
			expect(remaining).toHaveLength(1)
		})
	})
})
