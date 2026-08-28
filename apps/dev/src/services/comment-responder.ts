/**
 * Routes a new comment to the agents that should react to it.
 *
 * The comment analogue of `conversation-responder.ts`, and deliberately built
 * to the same shape: agents get one long-lived **interactive** session per
 * (comment thread, agent) pair, and each subsequent comment in that thread is
 * delivered into the live session with `writeInput` rather than spawning a
 * fresh container. A new top-level comment starts a new thread — and therefore
 * a new session — because a top-level comment is its own thread root.
 *
 * Before this existed, every comment spawned a one-shot non-interactive
 * session: two comments in a row at the same agent produced two independent
 * containers that could not see each other's work, and the human's follow-up
 * effectively restarted the agent from scratch.
 *
 * The authoritative guard against double-spawn is the DB's
 * `sessions_comment_thread_actor_active_uniq` partial unique index, not the
 * lookup below — two comments landing at once both find no session and both
 * try to insert.
 */
import type { Database } from '@maskin/db'
import { events, actors, commentPendingTurns } from '@maskin/db/schema'
import { and, asc, eq, lte, or, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { SessionManager } from './session-manager'

/** How many recent thread comments the seed prompt inlines. */
const SEED_HISTORY_LIMIT = 20

type TurnPayload = { type: 'user'; message: { role: 'user'; content: string } }

export interface RouteCommentToAgentParams {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	agentId: string
	objectId: string
	/** `events.id` of the thread root — the comment's own id when top-level. */
	threadRootEventId: number
	/** `events.id` of the comment that triggered this turn. */
	commentEventId: number
	commenterActorId: string
	content: string
	/**
	 * `mention` — the agent was @mentioned on this comment and owes the
	 * notification a resolution. `thread_reply` — the agent participated in
	 * this thread earlier and is being offered the turn implicitly.
	 */
	kind: 'mention' | 'thread_reply'
	/** Present only for `kind: 'mention'`. */
	notificationId?: string
}

/**
 * Deliver this comment to `agentId`: into its live session for the thread if
 * one exists, buffered if that session is still booting, otherwise by spawning
 * a fresh interactive session seeded with the thread's recent history.
 *
 * Never throws — a routing failure must not fail the comment that triggered it.
 */
export async function routeCommentToAgent(params: RouteCommentToAgentParams): Promise<void> {
	const { db, sessionManager, agentId, threadRootEventId, commentEventId } = params
	try {
		const turnPayload = buildTurnPayload(params)

		const existing = await sessionManager.findCommentThreadSessionAnyActive(
			threadRootEventId,
			agentId,
		)
		if (existing && existing.status !== 'running') {
			// Still booting (pending/starting/queued) — stdin isn't attached, so a
			// writeInput would fail and a second createSession would lose to
			// sessions_comment_thread_actor_active_uniq. Buffer it instead.
			await bufferPendingCommentTurn(db, {
				threadRootEventId,
				agentId,
				commentEventId,
				payload: turnPayload,
			})
			// Close the race: the session may have reached `running` (and already
			// drained) between the lookup and the insert, in which case nothing
			// would ever deliver this row.
			const nowRunning = await sessionManager.findActiveCommentThreadSession(
				threadRootEventId,
				agentId,
			)
			if (nowRunning) await sessionManager.drainPendingCommentTurns(nowRunning.id)
			return
		}

		if (existing) {
			try {
				await sessionManager.writeInput(existing.id, turnPayload, undefined, commentEventId)
				return
			} catch (err) {
				logger.warn(
					'writeInput to existing interactive comment-thread session failed — spawning a fresh one',
					{ agentId, threadRootEventId, sessionId: existing.id, error: String(err) },
				)
				// The old session is dead, not busy. Mark it failed now — otherwise
				// it keeps satisfying the active-uniq index and the fresh
				// createSession below collides with its own zombie.
				await sessionManager
					.markSessionFailedAfterContainerLoss(existing.id, existing.workspaceId)
					.catch((markErr: unknown) =>
						logger.warn('Failed to mark dead comment-thread session as failed', {
							agentId,
							threadRootEventId,
							sessionId: existing.id,
							error: String(markErr),
						}),
					)
			}
		}

		await spawnOrJoinCommentThreadSession(params, turnPayload)
	} catch (err) {
		logger.error('Failed to route comment to agent', {
			agentId,
			threadRootEventId,
			commentEventId,
			error: String(err),
		})
	}
}

async function spawnOrJoinCommentThreadSession(
	params: RouteCommentToAgentParams,
	turnPayload: TurnPayload,
): Promise<void> {
	const {
		db,
		sessionManager,
		workspaceId,
		agentId,
		objectId,
		threadRootEventId,
		commentEventId,
		commenterActorId,
		content,
		kind,
		notificationId,
	} = params

	const history = await loadThreadHistory(db, workspaceId, objectId, threadRootEventId)

	try {
		await sessionManager.createSession(workspaceId, {
			actorId: agentId,
			actionPrompt:
				kind === 'mention'
					? buildMentionSeedPrompt({
							objectId,
							commenterActorId,
							content,
							threadRootEventId,
							history,
							notificationId,
						})
					: buildThreadReplySeedPrompt({
							objectId,
							commenterActorId,
							content,
							threadRootEventId,
							history,
						}),
			config: {
				interactive: true,
				comment_thread: {
					object_id: objectId,
					thread_root_event_id: threadRootEventId,
					seed_comment_event_id: commentEventId,
				},
				// Retained verbatim from the pre-interactive shape: the
				// `?mention_object_id=` session filter (routes/sessions.ts) and the
				// frontend's session-to-thread mapping both still read these.
				...(kind === 'mention'
					? {
							mention: {
								object_id: objectId,
								commenter_actor_id: commenterActorId,
								notification_id: notificationId,
								comment_event_id: commentEventId,
							},
						}
					: {
							thread_reply: {
								object_id: objectId,
								comment_event_id: commentEventId,
								thread_root_event_id: threadRootEventId,
								commenter_actor_id: commenterActorId,
							},
						}),
			},
			createdBy: commenterActorId,
		})
		// The seed prompt inlines thread history up to and including this comment,
		// so any turn still buffered for this pair from a previous, dead session is
		// already covered. Clear those rows so the post-boot drain doesn't
		// re-deliver them as duplicates.
		try {
			await db
				.delete(commentPendingTurns)
				.where(
					and(
						eq(commentPendingTurns.threadRootEventId, threadRootEventId),
						eq(commentPendingTurns.actorId, agentId),
						lte(commentPendingTurns.commentEventId, commentEventId),
					),
				)
		} catch (err) {
			logger.warn('Failed to clear seed-covered pending comment turns', {
				agentId,
				threadRootEventId,
				error: String(err),
			})
		}
		return
	} catch (err) {
		if (!isCommentThreadSessionRaceViolation(err)) {
			logger.error('Failed to create comment-thread session', {
				agentId,
				threadRootEventId,
				error: String(err),
			})
			return
		}
	}

	// Lost the insert race — join the winner instead of dropping this turn.
	const winner = await sessionManager.findCommentThreadSessionAnyActive(threadRootEventId, agentId)
	if (!winner) {
		// The winner died between rejecting our insert and this lookup. The next
		// comment spawns a fresh session whose seed history covers this one.
		logger.warn('Comment-thread session race: no winner visible — deferring to next spawn', {
			agentId,
			threadRootEventId,
		})
		return
	}
	if (winner.status !== 'running') {
		await bufferPendingCommentTurn(db, {
			threadRootEventId,
			agentId,
			commentEventId,
			payload: turnPayload,
		})
		const nowRunning = await sessionManager.findActiveCommentThreadSession(
			threadRootEventId,
			agentId,
		)
		if (nowRunning) await sessionManager.drainPendingCommentTurns(nowRunning.id)
		return
	}
	await sessionManager
		.writeInput(winner.id, turnPayload, undefined, commentEventId)
		.catch(async (err: unknown) => {
			logger.warn('Failed to join winning comment-thread session after race', {
				agentId,
				threadRootEventId,
				sessionId: winner.id,
				error: String(err),
			})
			// The "winner" is itself dead — mark it failed so it stops blocking the
			// unique index for the *next* comment.
			await sessionManager
				.markSessionFailedAfterContainerLoss(winner.id, winner.workspaceId)
				.catch(() => undefined)
		})
}

/**
 * Buffers one turn for a (thread root, agent) pair whose session is still
 * booting. Idempotent per (thread root, agent, comment) via the table's unique
 * index. Never throws: a buffering failure degrades to the pre-buffer
 * behaviour, where the turn is covered by the next spawn's seed history.
 */
async function bufferPendingCommentTurn(
	db: Database,
	params: {
		threadRootEventId: number
		agentId: string
		commentEventId: number
		payload: TurnPayload
	},
): Promise<void> {
	try {
		await db
			.insert(commentPendingTurns)
			.values({
				threadRootEventId: params.threadRootEventId,
				actorId: params.agentId,
				commentEventId: params.commentEventId,
				payload: params.payload,
			})
			.onConflictDoUpdate({
				target: [
					commentPendingTurns.threadRootEventId,
					commentPendingTurns.actorId,
					commentPendingTurns.commentEventId,
				],
				set: { payload: params.payload },
			})
		logger.info('Buffered comment turn while agent session boots', {
			agentId: params.agentId,
			threadRootEventId: params.threadRootEventId,
			commentEventId: params.commentEventId,
		})
	} catch (err) {
		logger.error('Failed to buffer comment turn', {
			agentId: params.agentId,
			threadRootEventId: params.threadRootEventId,
			commentEventId: params.commentEventId,
			error: String(err),
		})
	}
}

/** Walks err.cause for the sessions_comment_thread_actor_active_uniq violation (23505). */
export function isCommentThreadSessionRaceViolation(err: unknown): boolean {
	for (let cur: unknown = err; cur && typeof cur === 'object'; ) {
		const e = cur as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === 'sessions_comment_thread_actor_active_uniq') return true
			if (
				typeof e.message === 'string' &&
				e.message.includes('sessions_comment_thread_actor_active_uniq')
			)
				return true
		}
		cur = e.cause
	}
	return false
}

export interface ThreadHistoryEntry {
	actorName: string
	content: string
}

/**
 * The thread's recent comments, oldest first, for inlining into a seed prompt —
 * the comment analogue of the conversation responder's history block. A freshly
 * spawned session has no memory of the thread, so without this it would have to
 * spend its first turn fetching what we already have.
 */
async function loadThreadHistory(
	db: Database,
	workspaceId: string,
	objectId: string,
	threadRootEventId: number,
): Promise<ThreadHistoryEntry[]> {
	try {
		const rows = await db
			.select({ id: events.id, name: actors.name, data: events.data })
			.from(events)
			.leftJoin(actors, eq(actors.id, events.actorId))
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityType, 'object'),
					eq(events.entityId, objectId),
					eq(events.action, 'commented'),
					or(
						eq(events.id, threadRootEventId),
						// Text comparison, not `(data->>'parentEventId')::int` — the cast
						// throws on any row with a non-numeric value there, which would
						// take down history loading for the whole thread.
						sql`${events.data}->>'parentEventId' = ${String(threadRootEventId)}`,
					),
				),
			)
			.orderBy(asc(events.id))
			.limit(SEED_HISTORY_LIMIT)
		return rows.map((r) => ({
			actorName: r.name ?? 'Unknown',
			content: String((r.data as { content?: unknown } | null)?.content ?? ''),
		}))
	} catch (err) {
		logger.warn('Failed to load comment thread history for seed prompt', {
			objectId,
			threadRootEventId,
			error: String(err),
		})
		return []
	}
}

function formatThreadHistory(history: ThreadHistoryEntry[]): string[] {
	if (history.length === 0) return []
	return [
		'Thread so far (oldest first):',
		'"""',
		...history.map((h) => `${h.actorName}: ${h.content}`),
		'"""',
		'',
	]
}

/**
 * Shared tail for every comment prompt. Interactive sessions auto-post their
 * end-of-turn text as a threaded comment (see InteractiveTurnFinalizer), so the
 * agent must be told not to also post one itself — otherwise the thread gets
 * the same reply twice.
 */
function replyChannelNote(threadRootEventId: number): string[] {
	return [
		'',
		`Whatever you write as your final answer for this turn is automatically posted as a reply in this thread (parent_event_id ${threadRootEventId}). Do NOT also call create_comment to post that same reply — it would appear twice. Only call create_comment for a genuinely separate comment, e.g. an interim progress note or a comment on a different object.`,
		'If no response is warranted, end your turn with no text at all — silence is a valid outcome and nothing will be posted.',
		'',
		'This is a live thread: more comments may arrive as additional turns in this same session, so keep the context you build up.',
	]
}

export function buildMentionSeedPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	threadRootEventId: number
	history: ThreadHistoryEntry[]
	notificationId?: string
}): string {
	return [
		'You were @mentioned in a comment on an object. Read the comment and the object context, then decide what the right response is. The response can be any combination of:',
		'  - taking an action (updating the object, creating related work, running a tool, kicking off another session, etc.)',
		'  - posting a comment reply (to answer, discuss, acknowledge, or report what you did)',
		'  - doing nothing, if no response is warranted',
		'',
		"Let the context guide you — what is being asked explicitly, what's implied by the thread, and what would actually be useful. Action and comment aren't mutually exclusive: it's often right to do the work and post a short comment about it, or to comment first and then act, or just one or the other. Pick whatever genuinely fits.",
		'',
		`Object ID: ${ctx.objectId}`,
		`Thread root comment event ID: ${ctx.threadRootEventId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'',
		...formatThreadHistory(ctx.history),
		'Comment content:',
		'"""',
		ctx.content,
		'"""',
		...(ctx.notificationId
			? [
					'',
					`Once you have done whatever you decided to do (including if that's nothing), mark notification ${ctx.notificationId} as resolved.`,
				]
			: []),
		...replyChannelNote(ctx.threadRootEventId),
	].join('\n')
}

export function buildThreadReplySeedPrompt(ctx: {
	objectId: string
	commenterActorId: string
	content: string
	threadRootEventId: number
	history: ThreadHistoryEntry[]
}): string {
	return [
		'A new comment was added to a comment thread you previously participated in. You were NOT @mentioned — you are being notified because you commented or were @mentioned earlier in this thread.',
		'',
		'Read the thread context and assess whether a reply from you adds value. If a reply is helpful, give it. If not, take no action — silence is a valid outcome.',
		'',
		`Object ID: ${ctx.objectId}`,
		`Thread root comment event ID: ${ctx.threadRootEventId}`,
		`Commenter actor ID: ${ctx.commenterActorId}`,
		'',
		...formatThreadHistory(ctx.history),
		'New comment content:',
		'"""',
		ctx.content,
		'"""',
		...replyChannelNote(ctx.threadRootEventId),
	].join('\n')
}

/**
 * Follow-up turn for a session that is already live on this thread. Deliberately
 * short — the session already holds the object and thread context from its seed
 * turn, so restating it would only bury the new comment.
 */
export function buildCommentTurnPrompt(ctx: {
	commenterActorId: string
	content: string
	threadRootEventId: number
	wasMentioned: boolean
	notificationId?: string
}): string {
	return [
		ctx.wasMentioned
			? `A new comment in this thread @mentions you (from actor ${ctx.commenterActorId}):`
			: `A new comment was added to this thread (from actor ${ctx.commenterActorId}). You were not @mentioned — reply only if it adds value:`,
		'"""',
		ctx.content,
		'"""',
		...(ctx.notificationId
			? [
					'',
					`Once you have done whatever you decided to do (including if that's nothing), mark notification ${ctx.notificationId} as resolved.`,
				]
			: []),
		...replyChannelNote(ctx.threadRootEventId),
	].join('\n')
}

function buildTurnPayload(params: RouteCommentToAgentParams): TurnPayload {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: buildCommentTurnPrompt({
				commenterActorId: params.commenterActorId,
				content: params.content,
				threadRootEventId: params.threadRootEventId,
				wasMentioned: params.kind === 'mention',
				notificationId: params.notificationId,
			}),
		},
	}
}
