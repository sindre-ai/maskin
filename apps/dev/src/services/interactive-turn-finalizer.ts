import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import { MESSAGE_MAX_LENGTH, parseResultLine, scanTurnLine, splitLines } from '@maskin/shared'
import { and, desc, eq, like, lte } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { classifyTurnError } from '../lib/turn-error-classifier'
import type { StreamJsonUserMessage } from './container-manager'
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

/**
 * Every complete line in one session_logs row.
 *
 * splitLines drops the trailing partial, which for a stored row is the last
 * envelope when the chunk did not end on a newline — so terminate the row
 * first. A row is only ever a whole number of envelopes by the time it is
 * persisted; the cross-chunk partial is reassembled live by onStdout.
 */
const splitRowLines = (content: string): string[] =>
	splitLines(content.endsWith('\n') ? content : `${content}\n`).lines

/** Guards against a stream that never emits a newline eating memory. */
const MAX_BUFFERED_PARTIAL_BYTES = 256 * 1024
/** Bounds the in-process dedupe cache; the DB unique index is authoritative. */
const MAX_SEEN_KEYS = 500
/**
 * How far back the blank-result recovery scan reads, in session_logs ROWS.
 *
 * A row is one streamed block on the agent-server path but a raw Docker chunk
 * on the local path, where it can carry several newline-delimited envelopes —
 * so this bounds the query generously rather than exactly. A tool-heavy turn
 * runs to dozens of rows; the scan stops early at the turn boundary, so the
 * limit only bites on unusually long turns, where missing the reply is the
 * same silence we'd have had anyway.
 */
const RECOVERY_SCAN_LIMIT = 200

/**
 * How many times one turn is replayed after a transient model-API failure.
 *
 * Two, because the failure this exists for (an Anthropic 500 closing the turn)
 * is near-always gone on the first replay, and every attempt re-runs the whole
 * turn — tools included — at full token cost. A turn that fails three times is
 * not a blip, and the human is better served by being told than by waiting.
 */
const MAX_TURN_RETRIES = 2

/** Backoff before replay N. Length must be >= MAX_TURN_RETRIES. */
const RETRY_BACKOFF_MS: readonly number[] = [2_000, 8_000]

/** Bounds the per-turn attempt counters; keys are dropped LRU-style. */
const MAX_RETRY_KEYS = 500

/**
 * How long a replayed turn has to produce a `result` envelope before the human
 * is told it went nowhere.
 *
 * retryTurn resolves when the bytes are queued on stdin, which is NOT proof the
 * turn ran: a CLI wedged on stdin (see `.claude/rules/known-pitfalls.md`,
 * "Interactive Sessions Dispatched to a Remote Agent-Server Never Received
 * Their First Turn") swallows the write silently. Without this the failure
 * envelope is already marked handled, nothing is posted, and the human waits
 * out the session timeout — strictly worse than the raw blob this replaces.
 *
 * Generous, because a replayed turn re-runs its tools: it must only fire when
 * the turn genuinely never started, never on one that is merely slow.
 */
const REPLAY_ANSWER_TIMEOUT_MS = 5 * 60_000

/**
 * Longest a shutdown will wait for in-flight replays before exiting anyway.
 *
 * Deliberately under the 10s SIGTERM->SIGKILL grace period a container gets by
 * default: a budget longer than the grace is not a budget, it just means the
 * orchestrator kills us mid-settle instead.
 */
const SETTLE_RETRIES_TIMEOUT_MS = 8_000

/** What the human reads when the replays are used up. */
const RETRY_EXHAUSTED_MESSAGE =
	"I hit a temporary error from the Claude API and couldn't finish that — I retried and it kept failing. Send the message again and I'll pick it up."

/**
 * What the human reads when the failure was transient but no replay was ever
 * attempted. Distinct from RETRY_EXHAUSTED_MESSAGE on purpose: claiming a retry
 * that did not happen misdescribes what they are looking at.
 */
const RETRY_UNAVAILABLE_MESSAGE =
	"I hit a temporary error from the Claude API and couldn't finish that. Send the message again and I'll pick it up."

/** What the human reads when the replay could not reach a session that has gone. */
const RETRY_UNDELIVERABLE_MESSAGE =
	"I hit a temporary error from the Claude API and couldn't finish that, and this session ended before I could run it again. Start a new session to pick it up."

/** What the human reads when a replay was written but the turn never came back. */
const RETRY_UNANSWERED_MESSAGE =
	"I hit a temporary error from the Claude API and ran that again, but the run never came back. Send the message again and I'll pick it up."

/** What the human reads for a failure no replay would fix. */
const permanentErrorMessage = (detail: string): string =>
	`I couldn't complete that turn — the model API returned an error:\n\n${detail}`

/**
 * A replayed turn we are waiting on, plus everything needed to report it if it
 * never comes back. Held rather than closed over so any of the three things
 * that can end the wait — the turn answering, the session going away, the
 * process exiting — can settle it.
 */
type ReplayWatchdog = {
	timer: NodeJS.Timeout
	gate: SessionGate
	conversationId: string
	dedupeKey: string
	/** The failing turn's log id: only a result NEWER than this can stand it down. */
	armedAfterLogId: number
}

type SessionGate = {
	interactive: boolean
	conversationId: string | null
	actorId: string
	workspaceId: string
}

/**
 * Replays one failed turn on the session that produced it.
 *
 * Wired to SessionManager.writeInput, which already routes to the remote
 * agent-server or the local container as appropriate. Optional so the
 * finalizer stays constructible in tests and in any caller that has no way to
 * write stdin — without it, a transient failure reports to the human instead
 * of retrying, which is the pre-existing behaviour minus the raw JSON blob.
 */
export type RetryTurnFn = (sessionId: string, payload: StreamJsonUserMessage) => Promise<void>

export type InteractiveTurnFinalizerOptions = {
	retryTurn?: RetryTurnFn
	/** Test seam: replaces the backoff wait so specs don't sleep for real. */
	delay?: (ms: number) => Promise<void>
	/** Test seam: how long a replayed turn has to answer. */
	replyTimeoutMs?: number
}

export class InteractiveTurnFinalizer {
	private readonly db: Database
	/** sessionId -> trailing partial line carried over from the last chunk. */
	private readonly buffers = new Map<string, string>()
	/** sessionId -> cached gate lookup, so the common case costs no query. */
	private readonly gates = new Map<string, SessionGate | null>()
	/** dedupeKey -> seen. Fast path only; the unique index is the real guard. */
	private readonly seen = new Set<string>()
	/** `${sessionId}:${payloadHash}` -> replays already spent on that turn. */
	private readonly retryCounts = new Map<string, number>()
	/** In-flight replays, so shutdown and tests can wait for them to settle. */
	private readonly pendingRetries = new Set<Promise<void>>()
	/** sessionId -> the replayed turn we are waiting on a result line for. */
	private readonly replayWatchdogs = new Map<string, ReplayWatchdog>()
	private readonly retryTurn?: RetryTurnFn
	private readonly delay: (ms: number) => Promise<void>
	private readonly replyTimeoutMs: number

	constructor(db: Database, options: InteractiveTurnFinalizerOptions = {}) {
		this.db = db
		this.retryTurn = options.retryTurn
		this.delay =
			options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
		this.replyTimeoutMs = options.replyTimeoutMs ?? REPLAY_ANSWER_TIMEOUT_MS
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
		this.clearRetryCounts(sessionId)
		// A replay was written and its turn never came back; the session going
		// away is proof it never will. Fire the notice instead of dropping the
		// timer — a discarded watchdog leaves the human in an empty thread,
		// which is the exact failure this service exists to prevent.
		void this.fireReplayWatchdog(sessionId, 'the session ended')
		this.buffers.delete(sessionId)
		this.gates.delete(sessionId)
	}

	/**
	 * Forget the replay budgets held for one session.
	 *
	 * The budget exists to stop one turn being replayed forever, so it must not
	 * outlive the episode it was counting. Counters are keyed on the payload's
	 * content, and identical content recurs constantly in chat ("continue",
	 * "yes"), so a counter left behind by a replay that WORKED would silently
	 * spend the next such turn's budget before it had failed once — and then
	 * tell the human it had been retried when it had not.
	 */
	private clearRetryCounts(sessionId: string): void {
		for (const key of this.retryCounts.keys()) {
			if (key.startsWith(`${sessionId}:`)) this.retryCounts.delete(key)
		}
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
		// Any closing turn — reply or failure — is proof the CLI is reading its
		// stdin, which is the only thing the watchdog is waiting to learn.
		//
		// Gated on the log id, because the agent-server replays stdout on
		// reconnect: a re-delivered OLD result says nothing about the turn we
		// replayed, and standing the watchdog down on one would leave the human
		// with no message at all — the failure envelope is already in `seen`, so
		// nothing would ever post.
		const watchdog = this.replayWatchdogs.get(sessionId)
		if (watchdog && logId > watchdog.armedAfterLogId) this.disarmReplayWatchdog(sessionId)

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
		// A turn that ended on a model-API failure never produced a reply — the
		// text in the envelope is the error itself. Posting it verbatim (which
		// is what this path used to do) hands the human a raw JSON blob and
		// leaves them to re-send by hand, so try to replay the turn first and
		// fall back to something they can actually read.
		if (result.isError) {
			await this.handleFailedTurn(sessionId, gate, gate.conversationId, result, logId)
			return
		}

		// The turn closed cleanly, so whatever transient fault the replay budget
		// was counting is over. Release it here rather than on the replay's own
		// success, because this is the only point that proves the model API
		// answered — and because a clean turn from any input says as much.
		this.clearRetryCounts(sessionId)

		let text = result.text.trim()
		let recovered = false
		if (!text) {
			const fallback = await this.recoverTurnText(sessionId, logId, result.raw)
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

		await this.postTurnMessage(
			sessionId,
			gate,
			gate.conversationId,
			result,
			logId,
			text,
			recovered ? { recovered: true } : {},
		)
	}

	/**
	 * Persist one message for a closing turn, deduped on the `result` line.
	 *
	 * Shared by the reply path and the error path so a replayed log line can
	 * never double-post either kind.
	 */
	private async postTurnMessage(
		sessionId: string,
		gate: SessionGate,
		conversationId: string,
		result: ReturnType<typeof parseResultLine> & object,
		logId: number,
		text: string,
		extraMetadata: Record<string, unknown>,
	): Promise<void> {
		const dedupeKey = createHash('sha256').update(result.raw).digest('hex').slice(0, 32)
		if (this.seen.has(dedupeKey)) return

		const truncated = text.length > MESSAGE_MAX_LENGTH
		const content = truncated ? text.slice(0, MESSAGE_MAX_LENGTH) : text
		const turnMessageId = await this.resolveTurnMessageId(sessionId, logId)

		const created = await insertConversationMessage(this.db, {
			conversationId,
			workspaceId: gate.workspaceId,
			actorId: gate.actorId,
			content,
			metadata: {
				source: 'final_output',
				final_output: {
					dedupe_key: dedupeKey,
					message_id: turnMessageId,
					...extraMetadata,
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
	 * A turn that closed with `is_error: true`: replay it if that stands a
	 * chance of working, otherwise tell the human in words.
	 *
	 * The replay is deliberately NOT awaited by the caller. This runs on the
	 * log-ingest path, and holding ingest open across a multi-second backoff
	 * would stall the live SSE feed for every other consumer of the same
	 * stream. The promise is tracked instead, so shutdown and tests can settle
	 * it.
	 */
	private async handleFailedTurn(
		sessionId: string,
		gate: SessionGate,
		conversationId: string,
		result: ReturnType<typeof parseResultLine> & object,
		logId: number,
	): Promise<void> {
		// The replay path posts nothing, so postTurnMessage's dedupe never runs
		// for it — check here too. The agent-server replays stdout on reconnect,
		// and a re-delivered failure envelope is the same failure, not a second
		// one to spend another attempt on.
		const dedupeKey = createHash('sha256').update(result.raw).digest('hex').slice(0, 32)
		if (this.seen.has(dedupeKey)) return

		const detail = result.text.trim() || 'no detail reported'
		const kind = classifyTurnError(detail)

		if (kind === 'permanent') {
			logger.warn(
				`Interactive session ${sessionId} turn failed permanently (log ${logId}): ${detail}`,
			)
			await this.postTurnMessage(
				sessionId,
				gate,
				conversationId,
				result,
				logId,
				permanentErrorMessage(detail),
				{
					error_kind: 'permanent',
				},
			)
			return
		}

		const payload = this.retryTurn ? await this.recoverTurnPayload(sessionId, logId) : null
		if (!payload) {
			// Either nothing can write stdin, or the turn's opening envelope has
			// aged out of the scan window. Both mean the same thing to the human.
			logger.warn(
				`Interactive session ${sessionId} hit a transient turn failure that cannot be replayed (log ${logId}): ${detail}`,
			)
			await this.postTurnMessage(
				sessionId,
				gate,
				conversationId,
				result,
				logId,
				RETRY_UNAVAILABLE_MESSAGE,
				{
					error_kind: 'transient',
					retry: 'unavailable',
				},
			)
			return
		}

		const retryKey = `${sessionId}:${createHash('sha256')
			.update(JSON.stringify(payload))
			.digest('hex')
			.slice(0, 16)}`
		const spent = this.retryCounts.get(retryKey) ?? 0

		if (spent >= MAX_TURN_RETRIES) {
			logger.warn(
				`Interactive session ${sessionId} exhausted ${MAX_TURN_RETRIES} turn replays (log ${logId}): ${detail}`,
			)
			this.retryCounts.delete(retryKey)
			await this.postTurnMessage(
				sessionId,
				gate,
				conversationId,
				result,
				logId,
				RETRY_EXHAUSTED_MESSAGE,
				{
					error_kind: 'transient',
					retries: spent,
				},
			)
			return
		}

		this.rememberRetry(retryKey, spent + 1)
		this.rememberKey(dedupeKey)

		const backoffMs = RETRY_BACKOFF_MS[spent] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0
		logger.warn(
			`Interactive session ${sessionId} turn failed transiently (log ${logId}); replaying in ${backoffMs}ms (attempt ${spent + 1}/${MAX_TURN_RETRIES}): ${detail}`,
		)

		const task = (async () => {
			try {
				await this.delay(backoffMs)
				// The write only proves the bytes were queued, so the turn coming
				// back needs its own clock; postFinalOutput stops it.
				//
				// Armed BEFORE the write, not after: writeInput resolves only once
				// the agent-server has answered and the envelope has been persisted,
				// and a fast turn can close inside that window. Arming afterwards
				// would leave a watchdog running against a turn whose reply the
				// human has already read, and fire a contradiction into their chat
				// five minutes later.
				this.armReplayWatchdog(sessionId, gate, conversationId, dedupeKey, logId)
				try {
					await this.retryTurn?.(sessionId, payload)
				} catch (err) {
					// Nothing is coming: stand the watchdog down so the undeliverable
					// notice below is the only thing the human is told.
					this.disarmReplayWatchdog(sessionId)
					throw err
				}
			} catch (err) {
				// The session may have been stopped or closed while we waited.
				// Nothing left to retry with, so say so rather than leaving the
				// human watching an empty thread.
				logger.error(
					`Interactive session ${sessionId} turn replay failed to reach the CLI: ${describeError(err)}`,
				)
				await this.postRetryNotice(
					sessionId,
					gate,
					conversationId,
					dedupeKey,
					'undeliverable',
					RETRY_UNDELIVERABLE_MESSAGE,
				)
			}
		})()

		this.pendingRetries.add(task)
		void task.finally(() => this.pendingRetries.delete(task))
	}

	/**
	 * A notice about a replay that never ran, posted outside postTurnMessage
	 * because the `result` envelope's own dedupe key is already spent — reusing
	 * it would let the unique index swallow the one message that keeps the
	 * human out of an empty thread.
	 */
	private async postRetryNotice(
		sessionId: string,
		gate: SessionGate,
		conversationId: string,
		dedupeKey: string,
		reason: 'undeliverable' | 'unanswered',
		content: string,
	): Promise<void> {
		try {
			const created = await insertConversationMessage(this.db, {
				conversationId,
				workspaceId: gate.workspaceId,
				actorId: gate.actorId,
				content,
				metadata: {
					source: 'final_output',
					final_output: {
						dedupe_key: `${dedupeKey}-${reason}`,
						error_kind: 'transient',
						retry: reason,
					},
				},
				sessionId,
			})
			if (!created) {
				// Suppressed by the unique index. Benign on a re-delivered log
				// line, but indistinguishable here from the notice going missing,
				// so leave a trace either way.
				logger.warn(
					`Interactive session ${sessionId} ${reason} notice was suppressed as a duplicate (dedupe_key ${dedupeKey}-${reason})`,
				)
			}
		} catch (err) {
			logger.error(
				`Interactive session ${sessionId} could not report a failed turn replay: ${describeError(err)}`,
			)
		}
	}

	/**
	 * Start the clock on a replayed turn producing a `result` envelope.
	 *
	 * unref'd: this must never be the reason a process stays alive, and a
	 * shutdown that drops it loses nothing a restart would have kept anyway.
	 */
	private armReplayWatchdog(
		sessionId: string,
		gate: SessionGate,
		conversationId: string,
		dedupeKey: string,
		armedAfterLogId: number,
	): void {
		this.disarmReplayWatchdog(sessionId)
		const timer = setTimeout(() => {
			void this.fireReplayWatchdog(sessionId, `no result arrived within ${this.replyTimeoutMs}ms`)
		}, this.replyTimeoutMs)
		timer.unref?.()
		this.replayWatchdogs.set(sessionId, {
			timer,
			gate,
			conversationId,
			dedupeKey,
			armedAfterLogId,
		})
	}

	/**
	 * Report a replayed turn that never came back — now, rather than on the
	 * watchdog's own clock.
	 *
	 * Called both when that clock runs out and when something has made the
	 * answer impossible before it could: the session went away, or the process
	 * is exiting. In those two cases the timer would simply be discarded (it is
	 * unref'd and in-process) with the human's turn still unaccounted for. No-op
	 * when nothing is armed, so every caller can call it unconditionally.
	 */
	private async fireReplayWatchdog(sessionId: string, why: string): Promise<void> {
		const watchdog = this.replayWatchdogs.get(sessionId)
		if (!watchdog) return
		this.disarmReplayWatchdog(sessionId)
		logger.error(
			`Interactive session ${sessionId} replayed a turn but saw no result; reporting it because ${why}`,
		)
		await this.postRetryNotice(
			sessionId,
			watchdog.gate,
			watchdog.conversationId,
			watchdog.dedupeKey,
			'unanswered',
			RETRY_UNANSWERED_MESSAGE,
		)
	}

	private disarmReplayWatchdog(sessionId: string): void {
		const watchdog = this.replayWatchdogs.get(sessionId)
		if (!watchdog) return
		clearTimeout(watchdog.timer)
		this.replayWatchdogs.delete(sessionId)
	}

	/**
	 * Waits for every in-flight turn replay to settle. For shutdown and tests;
	 * never throws, because each replay already handles its own failure.
	 *
	 * Bounded: a replay that finishes can start no new one, but log ingest is
	 * still running during a shutdown and could keep adding them, and an exit
	 * that waits forever is worse than one that drops a retry.
	 */
	async settlePendingRetries(timeoutMs = SETTLE_RETRIES_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (this.pendingRetries.size > 0) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) break
			// Raced against the deadline, not merely checked between iterations:
			// Promise.allSettled has no timeout of its own, so one replay whose
			// write hangs (writeInput's fetch to an agent-server carries no
			// AbortSignal) would make this — and the process exit that awaits it —
			// wait forever, leaving SIGKILL as the only way out.
			await Promise.race([
				Promise.allSettled([...this.pendingRetries]),
				new Promise<void>((resolve) => {
					setTimeout(resolve, remaining).unref?.()
				}),
			])
		}
		if (this.pendingRetries.size > 0) {
			logger.warn(
				`Gave up waiting for ${this.pendingRetries.size} in-flight turn replay(s) after ${timeoutMs}ms`,
			)
		}
		// An armed watchdog is an unref'd timer holding nothing but a human's
		// unanswered turn: exiting drops it silently. Report them instead. A
		// session that survives the restart and answers afterwards makes this
		// notice redundant, which is the better of the two mistakes.
		await Promise.allSettled(
			[...this.replayWatchdogs.keys()].map((id) =>
				this.fireReplayWatchdog(id, 'the server is shutting down'),
			),
		)
	}

	/**
	 * The user-turn envelope that opened the turn now failing, ready to write
	 * back to the CLI's stdin verbatim.
	 *
	 * Walks stdout backwards for a `user` envelope whose `message.content` is a
	 * string. That shape is the discriminator: writeInput always writes a
	 * string, while the `user` envelopes the CLI itself emits mid-turn carry an
	 * ARRAY of tool_result blocks. Replaying one of those would feed the model
	 * a tool result with no matching tool call.
	 */
	private async recoverTurnPayload(
		sessionId: string,
		logId: number,
	): Promise<StreamJsonUserMessage | null> {
		const rows = await this.db
			.select({ content: sessionLogs.content })
			.from(sessionLogs)
			.where(
				and(
					eq(sessionLogs.sessionId, sessionId),
					lte(sessionLogs.id, logId),
					eq(sessionLogs.stream, 'stdout'),
				),
			)
			.orderBy(desc(sessionLogs.id))
			.limit(RECOVERY_SCAN_LIMIT)

		for (const row of rows) {
			const lines = splitRowLines(row.content)
			for (let i = lines.length - 1; i >= 0; i--) {
				let parsed: unknown
				try {
					parsed = JSON.parse((lines[i] ?? '').trim())
				} catch {
					continue
				}
				if (!parsed || typeof parsed !== 'object') continue
				const obj = parsed as Record<string, unknown>
				if (obj.type !== 'user') continue
				const message = obj.message as { role?: unknown; content?: unknown } | undefined
				if (!message || typeof message.content !== 'string') continue
				return { type: 'user', message: { role: 'user', content: message.content } }
			}
		}
		return null
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
	 * earlier turn — which would re-post a reply the human already read. A call
	 * to AskUserQuestion or to the post_conversation_message MCP tool is also a
	 * boundary: both put a message on the human's screen, so anything said
	 * before one of them has already been read. See scanTurnLine for why.
	 *
	 * Rows are split into lines before classifying. A session_logs row is one
	 * envelope on the agent-server path but a raw Docker chunk on the local one
	 * (session-manager writes `chunk.data` verbatim), and scanTurnLine parses a
	 * whole line — so a packed chunk would classify as 'other', which both loses
	 * the reply AND fails to detect a boundary buried in it. Failing to detect a
	 * boundary is the dangerous half: the scan walks into the previous turn and
	 * re-posts a reply the human already read.
	 *
	 * Returns the LAST non-empty assistant text of the turn. Mid-turn narration
	 * ("let me check X") can win that way when the agent said nothing else, but
	 * a slightly over-eager bubble beats a lost reply, and the message is
	 * tagged `recovered` so this path stays visible in the data.
	 */
	private async recoverTurnText(
		sessionId: string,
		logId: number,
		resultRaw: string,
	): Promise<string> {
		const rows = await this.db
			.select({ id: sessionLogs.id, content: sessionLogs.content })
			.from(sessionLogs)
			.where(
				and(
					eq(sessionLogs.sessionId, sessionId),
					// Inclusive: the reply usually shares its chunk with the blank
					// result that triggered this scan, so excluding that row would
					// skip the single most likely place the lost text is sitting.
					lte(sessionLogs.id, logId),
					eq(sessionLogs.stream, 'stdout'),
				),
			)
			.orderBy(desc(sessionLogs.id))
			.limit(RECOVERY_SCAN_LIMIT)

		for (const row of rows) {
			let lines = splitRowLines(row.content)

			if (row.id === logId) {
				// Read only what precedes the triggering result line: anything
				// after it in the same chunk belongs to the NEXT turn. If it is
				// not found the line was completed from a partial carried out of
				// an earlier chunk, so skip the row rather than risk reading
				// forward across the boundary.
				const at = lines.findIndex((line) => line.trim() === resultRaw)
				lines = at === -1 ? [] : lines.slice(0, at)
			}

			for (let i = lines.length - 1; i >= 0; i--) {
				const scanned = scanTurnLine(lines[i] ?? '')
				if (scanned.kind === 'boundary') return ''
				if (scanned.kind === 'assistant_text') return scanned.text.trim()
			}
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
	 *
	 * Split into lines for the same reason recoverTurnText does: the tagged
	 * envelope can share a Docker chunk with its neighbours, and parsing the
	 * whole row would throw and silently yield an unanchored message.
	 */
	private async resolveTurnMessageId(sessionId: string, logId: number): Promise<number | null> {
		const [row] = await this.db
			.select({ content: sessionLogs.content })
			.from(sessionLogs)
			.where(
				and(
					eq(sessionLogs.sessionId, sessionId),
					lte(sessionLogs.id, logId),
					eq(sessionLogs.stream, 'stdout'),
					like(sessionLogs.content, '%maskin_message_id%'),
				),
			)
			.orderBy(desc(sessionLogs.id))
			.limit(1)

		if (!row) return null
		const lines = splitRowLines(row.content)
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const parsed = JSON.parse((lines[i] ?? '').trim()) as { maskin_message_id?: unknown }
				if (typeof parsed.maskin_message_id === 'number') return parsed.maskin_message_id
			} catch {
				// Not JSON, or a partial — keep walking the row's other lines.
			}
		}
		return null
	}

	private rememberRetry(retryKey: string, count: number): void {
		if (!this.retryCounts.has(retryKey) && this.retryCounts.size >= MAX_RETRY_KEYS) {
			const oldest = this.retryCounts.keys().next().value
			if (oldest !== undefined) this.retryCounts.delete(oldest)
		}
		this.retryCounts.set(retryKey, count)
	}

	private rememberKey(dedupeKey: string): void {
		if (this.seen.size >= MAX_SEEN_KEYS) {
			const oldest = this.seen.values().next().value
			if (oldest !== undefined) this.seen.delete(oldest)
		}
		this.seen.add(dedupeKey)
	}
}
