import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import { MESSAGE_MAX_LENGTH, parseResultLine, scanTurnLine, splitLines } from '@maskin/shared'
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

const describeError = (err: unknown): string =>
	err instanceof Error ? err.stack || err.message : String(err)

/** Guards against a stream that never emits a newline eating memory. */
const MAX_BUFFERED_PARTIAL_BYTES = 256 * 1024
/** Bounds the in-process dedupe cache; the DB unique index is authoritative. */
const MAX_SEEN_KEYS = 500
/**
 * How far back the blank-result recovery scan reads. A turn's stdout is one row
 * per streamed block, so a tool-heavy turn runs to dozens of rows; this is sized
 * to cover a normal turn while keeping the query bounded. The scan stops early
 * at the turn boundary, so the limit only bites on unusually long turns — where
 * missing the reply is the same silence we'd have had anyway.
 */
const RECOVERY_SCAN_LIMIT = 200

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
		let lines: string[] = []
		try {
			const carried = this.buffers.get(sessionId) ?? ''
			const split = splitLines(carried + chunk)
			lines = split.lines
			const { remainder } = split

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
		} catch (err) {
			logger.error(
				`Interactive turn finalizer failed to split stdout for session ${sessionId}: ${describeError(err)}`,
			)
			return
		}

		// Per line, not per chunk: one line that fails to post must not discard the
		// result lines after it in the same chunk. The buffer has already advanced,
		// so a dropped line is a permanently lost reply — the exact silence this
		// service exists to prevent. Log it loudly enough to be actionable.
		for (const line of lines) {
			try {
				const result = parseResultLine(line)
				if (result) await this.postFinalOutput(sessionId, result, logId)
			} catch (err) {
				logger.error(
					`Interactive turn finalizer failed to post final output for session ${sessionId} (log ${logId}): ${describeError(err)}`,
				)
			}
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
		if (!gate) return
		if (!gate.interactive) return
		if (!gate.conversationId) {
			logger.warn(
				`Interactive session ${sessionId} produced final output before a conversation was attached; dropping this turn's reply`,
			)
			return
		}

		// The `result` envelope is the intended carrier for the turn's reply, but
		// it is not reliable: when the model's turn ends on a non-text block (a
		// trailing `thinking` block, most often after a tool it could not use),
		// the CLI closes the turn with a blank `result` while the reply the human
		// was meant to read sits in an earlier `assistant` line. Recover it from
		// the log rather than dropping the turn — that silence is the exact
		// failure this service exists to prevent.
		let text = result.text.trim()
		let recovered = false
		if (!text) {
			const fallback = await this.recoverTurnText(sessionId, logId)
			if (fallback) {
				text = fallback
				recovered = true
			}
		}

		// A turn that genuinely produced no text has nothing to say — most often
		// the agent already replied via the MCP tool and ended silently. Posting
		// an empty bubble would be worse than the silence we're fixing. Logged
		// because a false negative here is an invisible dropped reply, and this
		// was previously the one path in this service with no telemetry at all.
		if (!text) {
			logger.info(
				`Interactive session ${sessionId} closed a turn with no postable text (log ${logId}, subtype ${result.subtype ?? 'none'}); nothing to post`,
			)
			return
		}

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
					...(recovered ? { recovered: true } : {}),
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

	/**
	 * Only conclusive lookups are cached. A missing row, or an interactive
	 * session whose conversationId has not been written yet, is a transient
	 * state — caching it would drop every subsequent final output for that
	 * session for the life of the process, with the cache entry never revisited
	 * (forgetSession is the only eviction). Re-querying costs one indexed read
	 * per result line in the rare unresolved case.
	 */
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

		if (!row) {
			logger.warn(
				`Interactive turn finalizer found no session row for ${sessionId}; not caching the miss`,
			)
			return null
		}

		if (row.interactive && !row.conversationId) return row
		this.gates.set(sessionId, row)
		return row
	}

	/**
	 * The agent's last spoken text in the turn that is now closing.
	 *
	 * Walks this session's stdout backwards from the `result` line, stopping at
	 * the turn boundary (the previous `result`, or the user turn envelope that
	 * opened this one) so it can never surface something the agent said in an
	 * earlier turn — which would re-post a reply the human already read.
	 *
	 * Returns the LAST non-empty assistant text of the turn. Mid-turn narration
	 * ("let me check X") can win that way when the agent said nothing else, but
	 * a slightly over-eager bubble beats a lost reply, and the message is
	 * tagged `recovered` so this path stays visible in the data.
	 */
	private async recoverTurnText(sessionId: string, logId: number): Promise<string> {
		const rows = await this.db
			.select({ content: sessionLogs.content })
			.from(sessionLogs)
			.where(
				and(
					eq(sessionLogs.sessionId, sessionId),
					lt(sessionLogs.id, logId),
					eq(sessionLogs.stream, 'stdout'),
				),
			)
			.orderBy(desc(sessionLogs.id))
			.limit(RECOVERY_SCAN_LIMIT)

		for (const row of rows) {
			const scanned = scanTurnLine(row.content)
			if (scanned.kind === 'boundary') return ''
			if (scanned.kind === 'assistant_text') return scanned.text.trim()
		}
		return ''
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
