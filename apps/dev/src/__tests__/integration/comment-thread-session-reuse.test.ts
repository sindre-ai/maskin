/**
 * Comment threads reuse one interactive agent session (services/comment-responder.ts).
 *
 * Real Postgres, because the load-bearing part of this feature is a DB
 * semantic: `sessions_comment_thread_actor_active_uniq` is what actually stops
 * two near-simultaneous comments from spawning two containers, and a mocked
 * `db.insert` cannot raise a 23505.
 */
import { events, commentPendingTurns, sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { postComment } from '../../lib/comments'
import { routeCommentToAgent } from '../../services/comment-responder'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * A session manager that is real enough for the router: the find/drain helpers
 * read the same rows `createSession` writes, so reuse-vs-spawn is decided by
 * the actual DB state rather than by a canned mock answer.
 */
function createFakeSessionManager() {
	const writeInput = vi.fn().mockResolvedValue(undefined)
	const markSessionFailedAfterContainerLoss = vi.fn().mockResolvedValue(undefined)

	const findAnyActive = async (rootEventId: number, actorId: string) => {
		const rows = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.commentThreadRootEventId, rootEventId),
					eq(sessions.actorId, actorId),
					eq(sessions.interactive, true),
				),
			)
		return rows.find((r) => ['pending', 'starting', 'queued', 'running'].includes(r.status)) ?? null
	}

	const createSession = vi.fn(
		async (
			workspaceId: string,
			params: {
				actorId: string
				actionPrompt: string
				config?: Record<string, unknown>
				createdBy: string
			},
		) => {
			const config = params.config ?? {}
			const thread = config.comment_thread as { thread_root_event_id?: number } | undefined
			const [row] = await db
				.insert(sessions)
				.values({
					workspaceId,
					actorId: params.actorId,
					status: 'pending',
					actionPrompt: params.actionPrompt,
					config,
					interactive: config.interactive === true,
					commentThreadRootEventId: thread?.thread_root_event_id ?? null,
					createdBy: params.createdBy,
				})
				.returning()
			return row
		},
	)

	return {
		createSession,
		writeInput,
		markSessionFailedAfterContainerLoss,
		findCommentThreadSessionAnyActive: vi.fn(findAnyActive),
		findActiveCommentThreadSession: vi.fn(async (rootEventId: number, actorId: string) => {
			const row = await findAnyActive(rootEventId, actorId)
			return row && row.status === 'running' ? row : null
		}),
		drainPendingCommentTurns: vi.fn().mockResolvedValue(undefined),
	} as unknown as SessionManager & {
		createSession: ReturnType<typeof vi.fn>
		writeInput: ReturnType<typeof vi.fn>
		markSessionFailedAfterContainerLoss: ReturnType<typeof vi.fn>
		drainPendingCommentTurns: ReturnType<typeof vi.fn>
	}
}

describe('comment thread session reuse', () => {
	let workspaceId: string
	let humanId: string
	let objectId: string
	let agentId: string
	let otherAgentId: string
	let sessionManager: ReturnType<typeof createFakeSessionManager>

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		workspaceId = ws.id
		const obj = await insertObject(db, workspaceId, humanId)
		objectId = obj.id
		agentId = (await insertActor(db, { type: 'agent' })).id
		otherAgentId = (await insertActor(db, { type: 'agent' })).id
		sessionManager = createFakeSessionManager()
	})

	/** Post a comment and route it to `agentId`, returning the comment event. */
	async function comment(content: string, parentEventId?: number, agent = agentId) {
		const { comment: row } = await postComment(db, {
			workspaceId,
			actorId: humanId,
			entityId: objectId,
			content,
			parentEventId,
		})
		const threadRootEventId = parentEventId ?? row.id
		await routeCommentToAgent({
			db,
			sessionManager,
			workspaceId,
			agentId: agent,
			objectId,
			threadRootEventId,
			commentEventId: row.id,
			commenterActorId: humanId,
			content,
			kind: 'mention',
			notificationId: undefined,
		})
		return row
	}

	/** Flip every session an agent holds to `running`, as launchContainer does. */
	async function markRunning(agent = agentId) {
		await db
			.update(sessions)
			.set({ status: 'running' })
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.actorId, agent)))
	}

	async function sessionsForAgent(agent: string) {
		return db
			.select()
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.actorId, agent)))
	}

	it('spawns one interactive session for the first comment in a thread', async () => {
		const root = await comment('hey @agent, look at this')

		const rows = await sessionsForAgent(agentId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.interactive).toBe(true)
		expect(rows[0]?.commentThreadRootEventId).toBe(root.id)
		// The `mention` block is retained so the ?mention_object_id= filter and
		// pre-migration UI paths keep working.
		expect((rows[0]?.config as { mention?: { object_id?: string } }).mention?.object_id).toBe(
			objectId,
		)
	})

	it('delivers a follow-up in the same thread into the running session instead of spawning', async () => {
		const root = await comment('first')
		const [spawned] = await sessionsForAgent(agentId)
		await markRunning()

		const reply = await comment('second', root.id)

		expect(await sessionsForAgent(agentId)).toHaveLength(1)
		expect(sessionManager.writeInput).toHaveBeenCalledTimes(1)
		const [sessionId, payload, , seedId] = sessionManager.writeInput.mock.calls[0] as [
			string,
			{ message: { content: string } },
			unknown,
			number,
		]
		expect(sessionId).toBe(spawned?.id)
		expect(seedId).toBe(reply.id)
		expect(payload.message.content).toContain('second')
	})

	it('spawns a second session for a new top-level comment', async () => {
		const first = await comment('thread one')
		await markRunning()

		const second = await comment('thread two')

		const rows = await sessionsForAgent(agentId)
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.commentThreadRootEventId).sort()).toEqual([first.id, second.id].sort())
	})

	it('spawns a separate session for a different agent in the same thread', async () => {
		const root = await comment('hey both')
		await markRunning()

		await comment('and you too', root.id, otherAgentId)

		expect(await sessionsForAgent(agentId)).toHaveLength(1)
		expect(await sessionsForAgent(otherAgentId)).toHaveLength(1)
	})

	it('buffers the turn while the session is still booting, keyed on the comment', async () => {
		const root = await comment('first')
		// Session is left `pending` — stdin isn't attached, so nothing can be written.
		const reply = await comment('second', root.id)

		expect(sessionManager.writeInput).not.toHaveBeenCalled()
		const buffered = await db
			.select()
			.from(commentPendingTurns)
			.where(eq(commentPendingTurns.threadRootEventId, root.id))
		expect(buffered).toHaveLength(1)
		expect(buffered[0]?.commentEventId).toBe(reply.id)
		expect(buffered[0]?.actorId).toBe(agentId)
	})

	it('re-buffering the same comment updates the payload rather than duplicating', async () => {
		const root = await comment('first')
		const reply = await comment('second', root.id)
		await comment('second', root.id) // a retry of the same delivery

		const buffered = await db
			.select()
			.from(commentPendingTurns)
			.where(eq(commentPendingTurns.threadRootEventId, root.id))
		// Two distinct comment events, each buffered once — no duplicate rows for
		// the (root, agent, comment) triple.
		expect(buffered.filter((b) => b.commentEventId === reply.id)).toHaveLength(1)
	})

	describe('DB semantics the feature depends on', () => {
		it('rejects a second active interactive session for the same (thread root, agent)', async () => {
			const root = await comment('first')

			await expect(
				insertSession(db, workspaceId, agentId, humanId, {
					status: 'pending',
					interactive: true,
					commentThreadRootEventId: root.id,
				}),
			).rejects.toMatchObject({ cause: { code: '23505' } })
		})

		it('allows a new session once the previous one is terminal', async () => {
			const root = await comment('first')
			await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.actorId, agentId))

			const second = await insertSession(db, workspaceId, agentId, humanId, {
				status: 'pending',
				interactive: true,
				commentThreadRootEventId: root.id,
			})
			expect(second.id).toBeDefined()
		})

		it('does not constrain non-interactive sessions on the same thread root', async () => {
			const root = await comment('first')

			const extra = await insertSession(db, workspaceId, agentId, humanId, {
				status: 'pending',
				interactive: false,
				commentThreadRootEventId: root.id,
			})
			expect(extra.id).toBeDefined()
		})

		it('rejects a duplicate buffered turn for the same (root, agent, comment)', async () => {
			const root = await comment('first')
			const reply = await comment('second', root.id)

			await expect(
				db.insert(commentPendingTurns).values({
					threadRootEventId: root.id,
					actorId: agentId,
					commentEventId: reply.id,
					payload: { type: 'user' },
				}),
			).rejects.toMatchObject({ cause: { code: '23505' } })
		})
	})

	it('self-heals a dead session: writeInput failure marks it failed and respawns', async () => {
		const root = await comment('first')
		const [dead] = await sessionsForAgent(agentId)
		await markRunning()

		sessionManager.writeInput.mockRejectedValueOnce(new Error('container gone'))
		// The router marks the zombie failed before respawning; do that for real so
		// the unique index actually frees up, as markSessionFailedAfterContainerLoss
		// does in production.
		sessionManager.markSessionFailedAfterContainerLoss.mockImplementationOnce(
			async (id: string) => {
				await db.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, id))
			},
		)

		await comment('second', root.id)

		const rows = await sessionsForAgent(agentId)
		expect(rows).toHaveLength(2)
		expect(rows.find((r) => r.id === dead?.id)?.status).toBe('failed')
		expect(rows.find((r) => r.id !== dead?.id)?.status).toBe('pending')
	})

	it('seeds a spawned session with the thread history so it does not start blind', async () => {
		const root = await comment('first question')
		// Kill the first session so the reply spawns a fresh one rather than reusing.
		await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.actorId, agentId))

		await comment('follow-up question', root.id)

		const prompts = sessionManager.createSession.mock.calls.map(
			(c) => (c[1] as { actionPrompt: string }).actionPrompt,
		)
		expect(prompts[1]).toContain('first question')
		expect(prompts[1]).toContain('follow-up question')
	})

	it('records the auto-posted reply as a threaded comment event', async () => {
		// Proves the sink the finalizer writes through: postComment with a
		// parentEventId lands in the thread, which is what makes an agent's
		// end-of-turn output visible without it calling create_comment.
		const root = await comment('question')
		const { comment: reply } = await postComment(db, {
			workspaceId,
			actorId: agentId,
			entityId: objectId,
			parentEventId: root.id,
			content: 'answer',
			metadata: { source: 'final_output', final_output: { dedupe_key: 'abc' } },
		})

		const [row] = await db.select().from(events).where(eq(events.id, reply.id))
		const data = row?.data as { parentEventId?: number; metadata?: { source?: string } }
		expect(data.parentEventId).toBe(root.id)
		expect(data.metadata?.source).toBe('final_output')
	})
})
