import type { Database } from '@maskin/db'
import { actors, messages, sessions } from '@maskin/db/schema'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * What a thread session knows about the rest of its chat (bet "Agents answer in the main chat and
 * in every thread at the same time"): a seed of the main chat when it starts, a note naming the
 * agent's other live sessions in the chat, and a one-line digest of what those sessions reply.
 *
 * Nothing here is behind a flag of its own. The seed and the note are only built when a thread
 * session is started, and the digest only has a receiver when two live sessions of one agent share a
 * chat; both exist only after the thread-sessions flag started a thread session (see pickSessionThread
 * in conversation-responder.ts). With the flag off none of this runs for a user.
 */

/** Main-chat messages a new thread session is seeded with, besides the thread root. Never more. */
export const THREAD_SEED_MAIN_CHAT_MESSAGES = 20
/** A seed message longer than this is cut, so the seed has a size bound as well as a count bound. */
const THREAD_SEED_MESSAGE_MAX_CHARS = 2000
/** Digest lines kept per receiving session; the oldest go first. */
const MAX_DIGESTS_PER_SESSION = 5
/** Sessions that hold digests at once; the oldest entry goes first. */
const MAX_DIGEST_SESSIONS = 500
const DIGEST_SNIPPET_CHARS = 120
const LABEL_SNIPPET_CHARS = 50
const LIVE_STATUSES = ['pending', 'starting', 'queued', 'running'] as const

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export interface ThreadSeed {
	history: Array<{ actorName: string; content: string }>
	/** Rough size of the seed, chars / 4, for the log. An estimate, not a tokenizer count. */
	approxTokens: number
}

/**
 * The context a new thread session starts with: the thread's root message, then the last
 * THREAD_SEED_MAIN_CHAT_MESSAGES top-level messages of the chat, oldest first. Replies inside any
 * thread are left out, so the seed is at most 21 messages, each at most 2000 characters. The
 * message the session is woken for is passed to the prompt on its own and is not part of this.
 */
export async function loadThreadSeed(
	db: Database,
	opts: { conversationId: string; threadRootId: number },
): Promise<ThreadSeed> {
	const { conversationId, threadRootId } = opts
	// A builder is single use, hence a function.
	const base = () =>
		db
			.select({ id: messages.id, actorName: actors.name, content: messages.content })
			.from(messages)
			.innerJoin(actors, eq(actors.id, messages.actorId))
	const recent = await base()
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.kind, 'message'),
				isNull(messages.threadRootId),
				ne(messages.id, threadRootId),
			),
		)
		.orderBy(desc(messages.id))
		.limit(THREAD_SEED_MAIN_CHAT_MESSAGES)
	// The root counts on top of the 20, so a thread under an old message still shows its root.
	const [root] = await base()
		.where(and(eq(messages.conversationId, conversationId), eq(messages.id, threadRootId)))
		.limit(1)
	const picked = (root ? [...recent, root] : recent).sort((a, b) => a.id - b.id)
	const history = picked.map((r) => ({
		actorName: r.actorName,
		content:
			r.content.length > THREAD_SEED_MESSAGE_MAX_CHARS
				? `${r.content.slice(0, THREAD_SEED_MESSAGE_MAX_CHARS)}…`
				: r.content,
	}))
	const chars = history.reduce((sum, m) => sum + m.actorName.length + m.content.length + 2, 0)
	return { history, approxTokens: Math.ceil(chars / 4) }
}

/** How a session's place reads in a note: the main chat, or the thread under a message. */
async function placeLabels(
	db: Database,
	conversationId: string,
	threadRootIds: Array<number | null>,
): Promise<Map<number | null, string>> {
	const labels = new Map<number | null, string>()
	const roots = threadRootIds.filter((id): id is number => id !== null)
	if (threadRootIds.includes(null)) labels.set(null, 'the main chat')
	if (roots.length === 0) return labels
	const rows = await db
		.select({ id: messages.id, content: messages.content })
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), inArray(messages.id, roots)))
	for (const id of roots) {
		const root = rows.find((r) => r.id === id)
		labels.set(id, `the thread "${root ? oneLine(root.content, LABEL_SNIPPET_CHARS) : id}"`)
	}
	return labels
}

/** The agent's live interactive sessions in this chat: the main-chat one and any thread sessions. */
async function findLiveChatSessions(
	db: Database,
	opts: { conversationId: string; agentId: string },
) {
	return db
		.select({ id: sessions.id, threadRootId: sessions.threadRootId })
		.from(sessions)
		.where(
			and(
				eq(sessions.conversationId, opts.conversationId),
				eq(sessions.actorId, opts.agentId),
				eq(sessions.interactive, true),
				inArray(sessions.status, [...LIVE_STATUSES]),
			),
		)
}

/**
 * The note a thread session starts with about its siblings: the agent's other live sessions in
 * this chat. Empty when there are none. Best effort: a failed lookup leaves the note out rather than
 * delay the session.
 */
export async function loadSiblingSessionsNote(
	db: Database,
	opts: { conversationId: string; agentId: string; threadRootId: number },
): Promise<string> {
	try {
		const siblings = (await findLiveChatSessions(db, opts)).filter(
			(s) => s.threadRootId !== opts.threadRootId,
		)
		if (siblings.length === 0) return ''
		const labels = await placeLabels(
			db,
			opts.conversationId,
			siblings.map((s) => s.threadRootId),
		)
		const lines = siblings.map((s) => `- ${labels.get(s.threadRootId) ?? 'another place'}`)
		return [
			'Your other live sessions in this chat. You are the same agent in each, but a session only sees its own turns. When one of them replies, you get a one-line digest with your next message. A digest is for context: never answer it.',
			...lines,
		].join('\n')
	} catch (err) {
		logger.warn('Could not load sibling sessions for a thread session', {
			conversation_id: opts.conversationId,
			error: String(err),
		})
		return ''
	}
}

/**
 * Digests waiting for a session's next turn. In memory on purpose: a digest is a courtesy, so one
 * lost to a restart costs nothing, and holding it here means it is never written to the session on
 * its own. A write to a session's input always starts a model turn, and that turn's output is
 * posted to the chat as a reply, so a digest sent that way would make the session answer it.
 */
const pendingDigests = new Map<string, string[]>()

function pushDigest(sessionId: string, line: string): void {
	const lines = pendingDigests.get(sessionId) ?? []
	lines.push(line)
	if (lines.length > MAX_DIGESTS_PER_SESSION) lines.shift()
	// Re-insert so the Map's order is least recently written first.
	pendingDigests.delete(sessionId)
	pendingDigests.set(sessionId, lines)
	if (pendingDigests.size > MAX_DIGEST_SESSIONS) {
		const oldest = pendingDigests.keys().next().value
		if (oldest !== undefined) pendingDigests.delete(oldest)
	}
}

interface ReplyDigest {
	conversationId: string
	agentId: string
	sessionId: string
	sessionThreadRootId: number | null
	content: string
}

/**
 * One session replied: leave a one-line digest for each of the agent's other live sessions in the
 * chat. Writes nothing to any session and posts nothing to the chat; the digest rides on the
 * receiver's next turn (see takeSessionDigests). Exported for tests, which await it; callers use
 * shareReplyDigest.
 */
export async function recordReplyDigest(db: Database, reply: ReplyDigest): Promise<void> {
	const live = await findLiveChatSessions(db, reply)
	// Only a chat session of this agent speaks for a place; a helper session that posted into
	// the chat is not one of them.
	if (!live.some((s) => s.id === reply.sessionId)) return
	const siblings = live.filter((s) => s.id !== reply.sessionId)
	if (siblings.length === 0) return
	const labels = await placeLabels(db, reply.conversationId, [reply.sessionThreadRootId])
	const place = labels.get(reply.sessionThreadRootId) ?? 'another place'
	const line = `Your session for ${place} replied: "${oneLine(reply.content, DIGEST_SNIPPET_CHARS)}"`
	for (const sibling of siblings) pushDigest(sibling.id, line)
}

/** recordReplyDigest, fire-and-forget and never throwing, so a digest failure cannot cost a reply. */
export function shareReplyDigest(db: Database, reply: ReplyDigest): void {
	recordReplyDigest(db, reply).catch((err: unknown) =>
		logger.warn('Failed to share a reply digest', {
			conversationId: reply.conversationId,
			error: String(err),
		}),
	)
}

/** Takes (and clears) the digests waiting for a session, as text to put after its next turn; '' if none. */
export function takeSessionDigests(sessionId: string): string {
	const lines = pendingDigests.get(sessionId)
	if (!lines || lines.length === 0) return ''
	pendingDigests.delete(sessionId)
	return [
		'Meanwhile in your other sessions in this chat (context only, do not answer this part):',
		...lines.map((l) => `- ${l}`),
	].join('\n')
}

/** Test helper: forget every waiting digest. */
export function _resetSessionDigests(): void {
	pendingDigests.clear()
}
