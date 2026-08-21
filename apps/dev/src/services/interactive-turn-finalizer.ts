import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import { MESSAGE_MAX_LENGTH, parseResultLine, splitLines } from '@maskin/shared'
import { and, desc, eq, like, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { insertConversationMessage } from './conversation-messages'

/**
 * Posts an agent's end-of-turn output into the chat it is talking in.
 *
 * Agents in interactive conversations routinely finish a turn without calling
 * the post_conversation_message MCP tool, and the human sees silence. The text
 * they *did* produce is right there in the stream-json `result` envelope, which
 * until now was read only for cost/token accounting and then thrown away. This
 * turns that envelope into the reply.
 *
 * Why the log-ingest path and not session completion: an interactive session is
 * long-lived and emits a `result` envelope at the end of EVERY turn, whereas
 * handleCompletion / markRemoteSessionComplete fire once, when the whole session
 * ends. Hooking completion would post one message per session, hours late.
 *
 * This never calls evaluateAndRespond, so an auto-posted final output is
 * structurally incapable of waking another agent — no agent-to-agent loop is
 * possible through this path.
 */

/** Guards against a stream that never emits a newline eating memory. */
const MAX_BUFFERED_PARTIAL_BYTES = 256 * 1024
/** Bounds the in-process dedupe cache; the DB unique index is authoritative. */
const MAX_SEEN_KEYS = 500

type SessionGate = {
	interactive: boolean
	conversationId: string | null
	actorId: string
	workspaceId: string
}

export class InteractiveTurnFinalizer {
	private readonly db: Database
	/** sessionId -> trailing partial line carried over from the last chunk. */
	private readonly buffers = new Map<string, string>()
	/** sessionId -> cached gate lookup, so the common case costs no query. */
	private readonly gates = new Map<string, SessionGate | null>()
	/** dedupeKey -> seen. Fast path only; the unique index is the real guard. */
	private readonly seen = new Set<string>()

	constructor(db: Database) {
		this.db = db
	}

	/**
	 * Feed one stdout chunk (local Docker) or one stdout line (agent-server).
	 * Never throws — a finalizer fault must not break log ingest.
	 */
	async onStdout(sessionId: string, chunk: string, logId: number): Promise<void> {
		try {
			const carried = this.buffers.get(sessionId) ?? ''
			const { lines, remainder } = splitLines(carried + chunk)

			if (remainder.length > MAX_BUFFERED_PARTIAL_BYTES) {
				logger.warn(
					`Dropping oversized partial stream-json line for session ${sessionId} (${remainder.length} bytes)`,
				)
				this.buffers.delete(sessionId)
			} else if (remainder) {
				this.buffers.set(sessionId, remainder)
			} else {
				this.buffers.delete(sessionId)
			}

			for (const line of lines) {
				const result = parseResultLine(line)
				if (result) await this.postFinalOutput(sessionId, result, logId)
			}
		} catch (err) {
			logger.error(
				`Interactive turn finalizer failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	/** Drop per-session state when a session goes away. */
	forgetSession(sessionId: string): void {
		this.buffers.delete(sessionId)
		this.gates.delete(sessionId)
	}

	/** Test seam: proves the DB unique index — not the cache — is the guard. */
	clearSeenCache(): void {
		this.seen.clear()
	}

	private async postFinalOutput(
		sessionId: string,
		result: ReturnType<typeof parseResultLine> & object,
		logId: number,
	): Promise<void> {
		const gate = await this.loadGate(sessionId)
		if (!gate?.interactive || !gate.conversationId) return

		const text = result.text.trim()
		// A turn that produced no text has nothing to say — most often the agent
		// already replied via the MCP tool and ended silently. Posting an empty
		// bubble would be worse than the silence we're fixing.
		if (!text) return

		const dedupeKey = createHash('sha256').update(result.raw).digest('hex').slice(0, 32)
		if (this.seen.has(dedupeKey)) return

		const truncated = text.length > MESSAGE_MAX_LENGTH
		const content = truncated ? text.slice(0, MESSAGE_MAX_LENGTH) : text
		const turnMessageId = await this.resolveTurnMessageId(sessionId, logId)

		const created = await insertConversationMessage(this.db, {
			conversationId: gate.conversationId,
			workspaceId: gate.workspaceId,
			actorId: gate.actorId,
			content,
			metadata: {
				source: 'final_output',
				final_output: {
					dedupe_key: dedupeKey,
					message_id: turnMessageId,
					...(result.isError ? { is_error: true } : {}),
					...(result.subtype ? { subtype: result.subtype } : {}),
					...(truncated ? { truncated: true } : {}),
				},
			},
			sessionId,
		})

		this.rememberKey(dedupeKey)

		if (!created) {
			// The unique index suppressed it — a replayed log line, not a new turn.
			// Logged because a false positive here is a silently dropped reply.
			logger.info(
				`Skipped duplicate final output for session ${sessionId} (dedupe_key ${dedupeKey})`,
			)
		}
	}

	private async loadGate(sessionId: string): Promise<SessionGate | null> {
		const cached = this.gates.get(sessionId)
		if (cached !== undefined) return cached

		const [row] = await this.db
			.select({
				interactive: sessions.interactive,
				conversationId: sessions.conversationId,
				actorId: sessions.actorId,
				workspaceId: sessions.workspaceId,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		const gate = row ?? null
		this.gates.set(sessionId, gate)
		return gate
	}

	/**
	 * Which chat message's turn produced this output.
	 *
	 * writeInput tags each user turn's persisted envelope with
	 * `maskin_message_id`; the nearest such envelope before this result is the
	 * turn that is now closing. Null is fine — a seeded first turn may carry no
	 * message id, and the frontend anchors those by position instead.
	 */
	private async resolveTurnMessageId(sessionId: string, logId: number): Promise<number | null> {
		const [row] = await this.db
			.select({ content: sessionLogs.content })
			.from(sessionLogs)
			.where(
				and(
					eq(sessionLogs.sessionId, sessionId),
					lt(sessionLogs.id, logId),
					eq(sessionLogs.stream, 'stdout'),
					like(sessionLogs.content, '%maskin_message_id%'),
				),
			)
			.orderBy(desc(sessionLogs.id))
			.limit(1)

		if (!row) return null
		try {
			const parsed = JSON.parse(row.content) as { maskin_message_id?: unknown }
			return typeof parsed.maskin_message_id === 'number' ? parsed.maskin_message_id : null
		} catch {
			return null
		}
	}

	private rememberKey(dedupeKey: string): void {
		if (this.seen.size >= MAX_SEEN_KEYS) {
			const oldest = this.seen.values().next().value
			if (oldest !== undefined) this.seen.delete(oldest)
		}
		this.seen.add(dedupeKey)
	}
}
