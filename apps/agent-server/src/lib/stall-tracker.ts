/**
 * Detects the silent wedge: a session that took a user turn and produced
 * nothing back.
 *
 * WHY THIS SHAPE. The failure this exists to catch has no error, no non-2xx,
 * and no exception. Both production incidents looked identical from outside —
 * the session sat in `running` until a timeout backstop fired hours later, and
 * we heard about it from a customer:
 *
 *   - PRs #1450-#1454: `s.write()` resolved into a dead socket, so a turn was
 *     consumed and destroyed with no end-to-end acknowledgement.
 *   - The `seedInteractiveTurn` bug (see .claude/rules/known-pitfalls.md):
 *     `SessionDispatcher.dispatch()` never called `writeInput` at all, so the
 *     VM booted cleanly and then blocked forever on a stdin nothing wrote to.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING: an idle session is not a stalled
 * session. An interactive chat sitting quiet because the human hasn't typed is
 * healthy, and is the common case. Alerting on "no output" would fire
 * constantly, we would mute it, and it would be worse than nothing. The signal
 * is the ASYMMETRY — input pending, output absent — plus one arm for the case
 * where the input never arrived at all.
 *
 * THREE ARMS, deliberately distinguished because they have very different
 * false-positive profiles and only two of them are worth paging on:
 *
 *   never_seeded  An interactive session that is live with zero turns ever
 *                 enqueued and zero output. This is the seedInteractiveTurn
 *                 shape, and the previous predicate could not see it at all:
 *                 `enqueue()` never fired, so there was no pending turn to
 *                 measure silence against. Near-silent in normal operation —
 *                 apps/dev seeds the first turn immediately after dispatch.
 *
 *   undelivered   A turn was enqueued and the guest's acked high-water mark
 *                 never advanced past it. This is the dead-socket shape. Also
 *                 near-silent: a healthy guest re-dials on its own idle
 *                 timeout (IDLE_TIMEOUT_MS = 90s in input-stream.js) and acks
 *                 on every (re)connect.
 *
 *   no_output     The guest acked the turn — it reached the CLI's stdin — and
 *                 no output has arrived since. This is the noisiest arm: a
 *                 genuinely long tool call or model response with no interim
 *                 output looks exactly like a wedge from here. Recorded as a
 *                 gauge, NOT alerted on, until its threshold can be set from
 *                 observed data rather than a guess.
 *
 * PENDING IS CLEARED BY COMPLETION, NOT BY OUTPUT. `turnPendingSince` is set
 * when a turn is enqueued and cleared only when the CLI emits its `result`
 * envelope for that turn (or the session ends). Ordinary output lines advance
 * `lastOutputAt` — which resets the silence clock, so a chatty tool call does
 * not trip the alert — but they do NOT end the pending window. Clearing on
 * first output would make an agent that emits one line and then wedges
 * invisible forever, which is precisely the failure mode of the second 2026-08
 * incident (`turn delivered, reply produced, nothing came back`). See the
 * "one output line, then silence" test.
 *
 * REATTACHED SESSIONS ARE NOT HEALTHY, THEY ARE UNOBSERVED. All state here is
 * in-memory, so a redeploy erases it. A session reattached by reconcileOnBoot
 * has no turn history in this process, and reporting it as fine would be a
 * lie in exactly the situation where we care most — we deploy when we are
 * shipping a fix and want to know whether it worked. Those sessions are
 * counted separately in `unobserved()` and excluded from every stall arm. A
 * firing alert that clears after a deploy is NOT evidence of a fix; see
 * observability/README.md.
 *
 * The blind spot is a window, not a life sentence: `turnEnqueued` clears the
 * flag, because the turn it is recording is history this process owns. A
 * reattached session that goes on to take a turn and then wedges is caught
 * normally.
 *
 * The clock is injected rather than read from `Date.now()` inline, so
 * threshold tests are deterministic without fake timers — same pattern as
 * guest-log-stream.ts.
 */

/** Arms of the stall predicate. BOUNDED — this is a metric label value. */
export type StallReason = 'never_seeded' | 'undelivered' | 'no_output'

export const STALL_REASONS: readonly StallReason[] = ['never_seeded', 'undelivered', 'no_output']

export type StallCounts = Record<StallReason, number>

/**
 * Default silence threshold.
 *
 * 5 minutes, which is ~3.3x input-stream.js's IDLE_TIMEOUT_MS of 90s — a guest
 * between re-dials is legitimately unacked for up to that long, and the
 * threshold must clear the worst case comfortably or `undelivered` fires on
 * healthy sessions.
 *
 * This multiple is derived from the code, NOT from the observed re-dial
 * distribution: the `input-stream: exiting with code N (lastSeq=...)` lines
 * that would give a real p99 only started shipping to Loki with #1462 and
 * there is not yet a week of them to query. Re-derive it once there is — the
 * LogQL query to do so is in observability/README.md — and move this number
 * (via AGENT_SERVER_STALL_THRESHOLD_MS, no deploy needed) rather than leaving
 * a code-derived guess in place indefinitely.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 300_000

type SessionState = {
	interactive: boolean
	/** Reattached by reconcileOnBoot: no turn history, never counted as stalled. */
	reattached: boolean
	startedAt: number
	/** Highest seq handed to InputQueue.enqueue for this session. 0 = never seeded. */
	enqueuedSeq: number
	/** Guest's acked high-water mark, from the `after` it sends on every re-dial. */
	ackedSeq: number
	/** When the ack last advanced — proof of life, resets the undelivered clock. */
	lastAckAt: number | null
	/** Start of the current unanswered turn. Cleared on `result`, not on output. */
	turnPendingSince: number | null
	/** Any output line since the pending window opened. Resets the silence clock. */
	lastOutputAt: number | null
}

export type StallTrackerOptions = {
	now?: () => number
	thresholdMs?: number
}

export class StallTracker {
	private sessions = new Map<string, SessionState>()
	private readonly now: () => number
	readonly thresholdMs: number

	constructor(options: StallTrackerOptions = {}) {
		this.now = options.now ?? Date.now
		this.thresholdMs = options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
	}

	/**
	 * Register a session at spawn. `interactive` comes from `INTERACTIVE=1` in
	 * the session env — only interactive sessions take user turns, so only they
	 * can exhibit the input-pending/output-absent asymmetry.
	 */
	trackSession(sessionId: string, opts: { interactive: boolean; reattached?: boolean }): void {
		this.sessions.set(sessionId, {
			interactive: opts.interactive,
			reattached: opts.reattached ?? false,
			startedAt: this.now(),
			enqueuedSeq: 0,
			ackedSeq: 0,
			lastAckAt: null,
			turnPendingSince: null,
			lastOutputAt: null,
		})
	}

	/**
	 * A user turn was handed to InputQueue. Opens the pending window.
	 *
	 * This also ends the reattach blind spot: a session reconcileOnBoot adopted
	 * has no turn history in this process, but the turn being enqueued right now
	 * *is* history this process owns, so from here the arms can judge it. Without
	 * this the flag would never clear and a survivor of a redeploy would sit in
	 * `unobserved()` for its whole life (up to SESSION_MAX_DURATION, several
	 * deploys) — silently exempt from detection in exactly the deploy-during-an-
	 * incident window the tracker exists for. Taking a turn also proves the
	 * session is interactive, whatever reconcile had to assume at boot.
	 */
	turnEnqueued(sessionId: string, seq: number): void {
		const s = this.sessions.get(sessionId)
		if (!s) return
		s.reattached = false
		s.interactive = true
		s.enqueuedSeq = Math.max(s.enqueuedSeq, seq)
		if (s.turnPendingSince === null) {
			s.turnPendingSince = this.now()
			// A new pending window measures silence from itself, not from output
			// belonging to the previous turn.
			s.lastOutputAt = null
		}
	}

	/**
	 * The guest reported its high-water mark on (re)connect. Only an ADVANCE
	 * counts: a guest re-dialling with the same `after` has proven nothing new,
	 * and treating it as liveness would reset the undelivered clock forever on
	 * exactly the blackholed session we are trying to catch.
	 */
	turnAcked(sessionId: string, ackedSeq: number): void {
		const s = this.sessions.get(sessionId)
		if (!s || !Number.isFinite(ackedSeq) || ackedSeq <= s.ackedSeq) return
		s.ackedSeq = ackedSeq
		s.lastAckAt = this.now()
	}

	/**
	 * A line of agent output arrived (via POST /sessions/:id/logs/batch — the
	 * CLI's own stdout). Advances the silence clock; ends the pending window
	 * only on the CLI's `result` envelope, which is what marks a turn answered.
	 *
	 * Lines from /logs/ingest are deliberately NOT routed here: that path
	 * carries input-stream.js's diagnostics and output-stream.js's gave-up
	 * marker, so counting them as output would let the very helpers reporting a
	 * broken session keep the session looking alive.
	 */
	outputObserved(sessionId: string, line: string): void {
		const s = this.sessions.get(sessionId)
		if (!s) return
		s.lastOutputAt = this.now()
		if (isTurnResult(line)) s.turnPendingSince = null
	}

	/** Session reached a terminal state — mirrors InputQueue.drainSession. */
	endSession(sessionId: string): void {
		this.sessions.delete(sessionId)
	}

	/** Sessions whose history this process never saw (restart blind spot). */
	unobserved(): number {
		let n = 0
		for (const s of this.sessions.values()) if (s.reattached) n++
		return n
	}

	tracked(): number {
		return this.sessions.size
	}

	/** Count of live sessions matching each arm. Never labelled by session id. */
	counts(): StallCounts {
		const counts: StallCounts = { never_seeded: 0, undelivered: 0, no_output: 0 }
		const now = this.now()
		for (const s of this.sessions.values()) {
			const reason = classify(s, now, this.thresholdMs)
			if (reason) counts[reason]++
		}
		return counts
	}
}

/**
 * The predicate itself, exported for direct unit testing.
 *
 * Arms are mutually exclusive by construction: `never_seeded` requires no turn
 * ever, and `undelivered`/`no_output` are split on whether the ack caught up.
 * A session is therefore counted at most once.
 */
function classify(s: SessionState, now: number, thresholdMs: number): StallReason | null {
	// No turn history in this process — unobserved, not healthy. Counted by
	// `unobserved()` instead so the blind spot is visible rather than silent.
	if (s.reattached) return null

	if (s.enqueuedSeq === 0) {
		// Never seeded: interactive, alive, and nothing has ever happened to it.
		// A batch session legitimately takes no turns, so this arm is interactive
		// only. Any output at all disproves it — the session is doing something,
		// even if apps/dev's seed was late.
		if (!s.interactive || s.lastOutputAt !== null) return null
		return now - s.startedAt >= thresholdMs ? 'never_seeded' : null
	}

	if (s.turnPendingSince === null) return null

	if (s.ackedSeq < s.enqueuedSeq) {
		// Undelivered: the newest turn has not been acked. A recent ack advance
		// is proof the guest is alive and consuming, so it resets the clock —
		// otherwise a burst of turns during a healthy conversation would count.
		const since = Math.max(s.turnPendingSince, s.lastAckAt ?? 0)
		return now - since >= thresholdMs ? 'undelivered' : null
	}

	// Acked but silent. Output resets the clock, so a long tool call that prints
	// anything at all keeps the session out of this arm; a genuinely silent long
	// model response does not, which is why this arm is recorded and not paged.
	const since = Math.max(s.turnPendingSince, s.lastOutputAt ?? 0)
	return now - since >= thresholdMs ? 'no_output' : null
}

/**
 * Does this output line end a turn?
 *
 * Lines on /logs/batch are the CLI's raw stream-json stdout, whose `result`
 * envelope is emitted once per completed turn — the same envelope apps/dev
 * waits for before posting the reply to the chat (see output-stream.js's
 * header). The cheap substring check runs first so the common case never
 * parses JSON.
 */
function isTurnResult(line: string): boolean {
	if (!line.includes('"result"')) return false
	try {
		const parsed: unknown = JSON.parse(line)
		return (
			typeof parsed === 'object' &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === 'result'
		)
	} catch {
		// Not JSON, or a partial line. Treated as ordinary output: it still
		// advances the silence clock, it just doesn't close the turn.
		return false
	}
}
