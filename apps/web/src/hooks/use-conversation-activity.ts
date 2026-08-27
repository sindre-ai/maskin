import { parseFailureReason } from '@/components/agents/session-detail-panel'
import type {
	ActivityStep,
	MessageActivitySegment,
} from '@/components/agents/session-log-transcript'
import {
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
} from '@/components/agents/session-log-transcript'
import type { MessageResponse, SessionResponse } from '@/lib/api'
import { toastSessionBudgetStopped } from '@/lib/session-errors'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionActivityLogs } from './use-session-activity-logs'
import { useActiveSessionsForConversation } from './use-sessions'

export interface MessageTurnActivity {
	sessionId: string
	actorId: string
	steps: ActivityStep[]
	/** True for the single most recent turn of a session that hasn't reached a `result` envelope yet. */
	inProgress: boolean
	/**
	 * True while the session is still booting (pending/starting/queued) — the
	 * spinner shows so the user knows a reply is on its way, but there is no
	 * live process to stop yet, so the stop control stays hidden.
	 */
	starting?: boolean
	/** True when the session that would have produced this turn failed before (or shortly after) starting. */
	failed?: boolean
	/**
	 * True when the turn stopped without either finishing or failing — the
	 * session hit the 2-hour reaper mid-turn, or its activity couldn't be
	 * loaded. Rendered neutrally rather than as a red failure: nothing is
	 * broken, but the user is waiting on a reply that isn't coming and needs
	 * to know that.
	 */
	interrupted?: boolean
	/**
	 * The agent's end-of-turn output, read straight from this turn's `result`
	 * envelope, shown only until the persisted `final_output` message arrives.
	 *
	 * The backend posts that message for real (interactive-turn-finalizer.ts);
	 * this exists so the reply appears the moment the turn closes rather than
	 * after the next poll + SSE invalidation round-trip. It is derived, not
	 * stateful — once the persisted row shows up in `messages`, the same render
	 * that draws the real bubble stops producing this one, so there is no
	 * duplicate frame to flicker through.
	 */
	pendingFinalOutput?: {
		text: string
		isError: boolean
		/** Stable across polls (embeds the result's log id) — safe as a React key. */
		key: string
		/**
		 * Set when the persisted row still hasn't appeared well after the turn
		 * closed, i.e. the backend insert probably failed. The text keeps
		 * showing — losing the agent's answer would be worse — but it is
		 * labelled as unsaved rather than silently passed off as a message.
		 */
		unconfirmed?: boolean
	}
}

export interface ConversationActivity {
	/**
	 * A finished turn's dropdown, keyed by the id of the reply message it
	 * actually produced — not the message that triggered it. In a group
	 * conversation several agents (or several turns of the same agent) can
	 * all be triggered by the same message, so anchoring by trigger would
	 * pile every one of those dropdowns under that one message, forever,
	 * regardless of which agent's reply they belong to. Anchoring by the
	 * reply instead means each dropdown ends up sitting with its own message.
	 */
	byReplyMessageId: Map<number, MessageTurnActivity[]>
	/**
	 * A still-in-progress turn's live dropdown, or a failed session's error
	 * notice, keyed by the message that triggered it — there's no reply yet
	 * (and never will be, if failed) to anchor it to instead. A live turn
	 * moves to `byReplyMessageId` once it posts a reply; if it resolves
	 * without posting one ("no action needed"), it just disappears. A failed
	 * turn stays put until the actor's next session for this conversation
	 * supersedes it (see the "latest session per actor" filtering above).
	 */
	byTriggerMessageId: Map<number, MessageTurnActivity[]>
	/**
	 * A still-in-progress turn whose `maskin_message_id` tag hasn't been
	 * logged yet (the brief window right after a turn starts), an older
	 * session whose turns predate message-id tagging, or a failed session
	 * whose `config.conversation.message_id` wasn't set. The caller should
	 * attach these to the newest message in the thread so something still
	 * shows immediately, matching the old "typing indicator" behavior for
	 * this edge case.
	 */
	fallback: MessageTurnActivity[]
	/**
	 * Reaches one step further back into this conversation's activity: pulls in
	 * the next not-yet-loaded terminal session, or, once they're all loaded,
	 * pages backward through the oldest one's logs.
	 *
	 * Opening an old chat deliberately loads no terminal-session logs — a
	 * finished conversation shouldn't fetch thousands of rows just to be read.
	 * This is the opt-in.
	 */
	loadOlderActivity: () => void
	olderActivity: { available: boolean; isLoading: boolean; exhausted: boolean }
}

/**
 * Segments the conversation's most recent session per agent into per-message
 * activity turns: a running session's turns are split from its logs and
 * re-anchored to the reply message they produced (see `byReplyMessageId`'s
 * doc comment for why); a failed session — whether it died before ever
 * reaching `running` (dispatch/enqueue failure) or ran for a while and then
 * failed (e.g. classified credit/rate-limit exhaustion) — instead surfaces a
 * single error notice anchored to the message that triggered it, otherwise a
 * failed session is invisible to the chat UI. Pairing a running session's
 * reply-producing segments with that same agent's own posted messages, in
 * chronological order, is reliable even though not every turn results in a
 * reply — turns that go silent are simply excluded from both lists, so the
 * pairing stays 1:1.
 *
 * Pairing is scoped by `actorId` + "posted at/after this session started",
 * NOT `messages.sessionId` — that column only gets populated when an agent's
 * MCP connection is stdio (env-var based, per container); the platform MCP
 * preset most agents actually use is HTTP-transport against the shared
 * backend process, where there's no single "current session" to read from
 * `process.env`, so `sessionId` comes back null for those replies. Only one
 * session can be active per (conversation, agent actor) at a time (enforced
 * by `sessions_conversation_actor_active_uniq`), and a new session can only
 * start once the previous one for that pair is terminal — so every message
 * this actor posted at or after `session.startedAt` unambiguously belongs to
 * this session, with no risk of pulling in an older, already-dead session's
 * messages.
 */
export function useConversationActivity(
	workspaceId: string,
	conversationId: string | null,
	messages: MessageResponse[],
): ConversationActivity {
	const { data: sessions } = useActiveSessionsForConversation(workspaceId, conversationId)

	// Sessions come back newest-first (see the route's `orderBy(desc(sessions.createdAt))`)
	// — keep only the latest session per agent, since that's the one whose
	// status actually reflects "what's happening now" for that agent. An
	// older failed attempt for an actor who has since retried (or replied
	// successfully) shouldn't keep showing a stale failure notice.
	const latestByActor = new Map<string, SessionResponse>()
	for (const session of sessions ?? []) {
		if (!latestByActor.has(session.actorId)) latestByActor.set(session.actorId, session)
	}
	const latestSessions = [...latestByActor.values()]
	const activeSessions = latestSessions.filter((s) => s.status === 'running')
	// A session on its way up. Container/VM boot is the single longest wait in
	// a chat turn — without surfacing these, the user stares at a silent
	// thread for the exact window where knowing "a reply is coming" matters
	// most. (Once running, the session appears via activeSessions instead.)
	const bootingSessions = latestSessions.filter(
		(s) => s.status === 'pending' || s.status === 'starting' || s.status === 'queued',
	)
	const failedSessions = latestSessions.filter((s) => s.status === 'failed')
	// 'timeout' is not a failure — the 2-hour backstop (session-manager.ts's
	// reaper) is expected lifecycle, and the next message in this conversation
	// spawns a fresh interactive session seeded with the recent history (see
	// conversation-responder.ts's spawnConversationSession). Whether a given
	// timeout is worth surfacing is decided per session below.
	const timedOutSessions = latestSessions.filter((s) => s.status === 'timeout')

	// Newest message in the thread — drives the log poll rate, so that sending
	// a message doesn't have to wait out an idle tick before the transcript
	// wakes up. See ACTIVE_GRACE_MS in use-session-activity-logs.ts.
	let lastMessageAt: number | null = null
	for (const message of messages) {
		if (!message.createdAt) continue
		const at = new Date(message.createdAt).getTime()
		if (!Number.isNaN(at) && (lastMessageAt === null || at > lastMessageAt)) lastMessageAt = at
	}

	// Terminal sessions are opt-in. Opening an old conversation must not kick
	// off log fetches for every session it ever had — but the user needs a way
	// to reach that history, so `loadOlderActivity` adds them one at a time.
	const [historySessionIds, setHistorySessionIds] = useState<string[]>([])
	const terminalSessions = latestSessions.filter((s) => s.status !== 'running')
	const watchedSessions = [
		...activeSessions,
		...terminalSessions.filter((s) => historySessionIds.includes(s.id)),
	]
	const pollableSessionIds = new Set(activeSessions.map((s) => s.id))

	const {
		queries: logsQueryList,
		loadOlder,
		backfill,
	} = useSessionActivityLogs(
		workspaceId,
		watchedSessions.map((s) => s.id),
		lastMessageAt,
		pollableSessionIds,
	)

	// Keyed by session id, NOT by array index. `watchedSessions` and
	// `activeSessions` diverge the moment a terminal session is opted into, and
	// index-based pairing would then silently hand one session's logs to
	// another — the kind of bug that looks like a rendering glitch.
	const logsBySession = new Map(
		watchedSessions.map((session, index) => [session.id, logsQueryList[index]]),
	)

	// A failing logs query used to be indistinguishable from a quiet session:
	// `data` is undefined, so the transcript rendered a contentless
	// in-progress dropdown and the agent appeared to work forever. It's
	// surfaced in the UI below; log it once per session so it isn't invisible
	// in telemetry either.
	const loggedLogErrors = useRef(new Set<string>())
	const erroredSessionIds = watchedSessions
		.filter((s) => logsBySession.get(s.id)?.isError)
		.map((s) => s.id)
	const erroredKey = erroredSessionIds.join(',')
	useEffect(() => {
		for (const id of erroredKey ? erroredKey.split(',') : []) {
			if (loggedLogErrors.current.has(id)) continue
			loggedLogErrors.current.add(id)
			console.error('[chat] failed to load session activity logs', id)
		}
	}, [erroredKey])

	// key -> when we first rendered this pending output. Drives the
	// `unconfirmed` label when the persisted row never shows up. A ref, not
	// state: it must not trigger a re-render, and the poll that would surface
	// the real message re-renders anyway.
	const pendingFirstSeen = useRef(new Map<string, number>())

	const byReplyMessageId = new Map<number, MessageTurnActivity[]>()
	const byTriggerMessageId = new Map<number, MessageTurnActivity[]>()
	const fallback: MessageTurnActivity[] = []

	for (const session of failedSessions) {
		const config = session.config as { conversation?: { message_id?: number } } | null
		const messageId = config?.conversation?.message_id
		// A user-initiated stop lands as status 'failed' with a marker in
		// result: `stopped_by_user` on the remote path's provisional write,
		// `user_stop_requested` once the genuine completion report (or the
		// local handleCompletion path) lands. Either way it's an expected
		// outcome, not an error — render it neutrally, like the mid-turn
		// timeout notice.
		const stoppedByUser =
			session.result?.stopped_by_user === true || session.result?.user_stop_requested === true
		// A session that reached `running` and later died from classified credit/rate-limit
		// exhaustion carries its message in `result.failure_reason.human_message`, not
		// `result.error` (see classifyCreditExhaustion() in session-manager.ts) — prefer
		// that curated message when present, since it's specific (e.g. "credit balance
		// exhausted") rather than the generic "could not be started" fallback copy.
		const errorText =
			parseFailureReason(session.result)?.human_message ||
			(typeof session.result?.error === 'string' ? session.result.error : undefined)
		const turn: MessageTurnActivity = stoppedByUser
			? {
					sessionId: session.id,
					actorId: session.actorId,
					steps: [
						{
							id: `${session.id}-stopped`,
							kind: 'error',
							text: 'Stopped — send another message (or retry) to continue.',
						},
					],
					inProgress: false,
					interrupted: true,
				}
			: {
					sessionId: session.id,
					actorId: session.actorId,
					steps: errorText ? [{ id: `${session.id}-error`, kind: 'error', text: errorText }] : [],
					inProgress: false,
					failed: true,
				}
		if (typeof messageId === 'number') {
			const list = byTriggerMessageId.get(messageId) ?? []
			list.push(turn)
			byTriggerMessageId.set(messageId, list)
		} else {
			fallback.push(turn)
		}
	}

	for (const session of timedOutSessions) {
		// Suppressing every timeout outright is a silent failure. A session
		// that timed out *mid-turn* leaves the user waiting on a reply that
		// will never arrive — see .claude/rules/known-pitfalls.md, "Interactive
		// Sessions Dispatched to a Remote Agent-Server Never Received Their
		// First Turn", where a hung session sat in `running` with zero logs
		// until this same reaper fired. Blanket suppression erases every trace
		// of that in a single tick, which is worse than the alarming notice it
		// replaced.
		//
		// Scope this to the CURRENT turn, not the whole session. An interactive
		// session is reused for the entire conversation (see
		// use-session-activity-logs.ts), so "this actor replied at some point
		// since the session started" is true for every conversation past its
		// first exchange — testing that would suppress the notice on exactly
		// the common path, leaving the user staring at a question with no
		// spinner, no notice and no error. The turn is unanswered only if a
		// message from someone else arrived after this actor's most recent
		// reply.
		// No floor from `startedAt`: the message that triggered a turn is posted
		// *before* the session responding to it starts, so seeding the cutoff
		// with the start time would exclude the very message being waited on.
		// With no replies yet, every message in the thread is unanswered.
		const actorReplies = messagesFromSession(messages, session)
		let lastReplyAt = Number.NEGATIVE_INFINITY
		for (const reply of actorReplies) {
			if (!reply.createdAt) continue
			const at = new Date(reply.createdAt).getTime()
			if (!Number.isNaN(at) && at > lastReplyAt) lastReplyAt = at
		}
		const unanswered = messages
			.flatMap((m) => {
				if (m.actorId === session.actorId) return []
				const at = m.createdAt ? new Date(m.createdAt).getTime() : Number.NaN
				if (Number.isNaN(at)) {
					// Undated message (mirrors messagesFromSession's leniency). We
					// can't prove it landed after a reply, so only count it as
					// unanswered when there is no reply to order it against.
					return lastReplyAt === Number.NEGATIVE_INFINITY
						? [{ message: m, at: Number.NEGATIVE_INFINITY }]
						: []
				}
				return at <= lastReplyAt ? [] : [{ message: m, at }]
			})
			.sort((a, b) => a.at - b.at)
		if (unanswered.length === 0) continue

		// Anchor to the message that actually went unanswered. `config.
		// conversation.message_id` is the message that *created* the session,
		// which on a reused session is the first message of the conversation —
		// hours above the one the user is waiting on.
		const messageId = unanswered[0]?.message.id
		const turn: MessageTurnActivity = {
			sessionId: session.id,
			actorId: session.actorId,
			steps: [
				{
					id: `${session.id}-timeout`,
					kind: 'error',
					text: 'Send another message to continue — the next one starts a fresh session seeded with the recent history.',
				},
			],
			inProgress: false,
			interrupted: true,
		}
		if (typeof messageId === 'number') {
			const list = byTriggerMessageId.get(messageId) ?? []
			list.push(turn)
			byTriggerMessageId.set(messageId, list)
		} else {
			fallback.push(turn)
		}
	}

	for (const session of bootingSessions) {
		// A booting session was spawned for a specific message — anchor its
		// "starting…" spinner there. (Reused sessions never sit in a booting
		// status, so config.conversation.message_id is the right anchor here,
		// unlike the timeout notice above.)
		const config = session.config as { conversation?: { message_id?: number } } | null
		const messageId = config?.conversation?.message_id
		const turn: MessageTurnActivity = {
			sessionId: session.id,
			actorId: session.actorId,
			steps: [],
			inProgress: true,
			starting: true,
		}
		if (typeof messageId === 'number') {
			const list = byTriggerMessageId.get(messageId) ?? []
			list.push(turn)
			byTriggerMessageId.set(messageId, list)
		} else {
			fallback.push(turn)
		}
	}

	for (const session of watchedSessions) {
		const query = logsBySession.get(session.id)
		const logs = query?.data ?? []
		// A terminal session contributes history only: its turns are all
		// finished, so nothing here should ever render as in progress.
		const isLive = session.status === 'running'
		// A failing poll must never leave a turn spinning. Note this is
		// deliberately NOT gated on `logs.length === 0`: React Query keeps the
		// last successful `data` and useSessionActivityLogs additionally
		// accumulates into a ref, so an empty array only ever means the very
		// FIRST fetch failed. The realistic degradation — polling worked, then
		// started failing — arrives here with logs still populated, and gating
		// on emptiness would fall straight through to `inProgress: true` and
		// spin for as long as the API stays down.
		const logsFailed = query?.isError === true
		if (logsFailed && logs.length === 0) {
			// Nothing to segment, and no way to know what the agent is doing.
			// Say so, instead of falling through to a spinner that never
			// resolves.
			fallback.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: [
					{
						id: `${session.id}-logs-error`,
						kind: 'error',
						text: "Couldn't load this turn's activity — retrying.",
					},
				],
				inProgress: false,
				interrupted: true,
			})
			continue
		}
		const { segments, unassigned } = segmentActivityByMessage(logs)
		const idle = !isLive || isSessionIdleAwaitingInput(logs)

		const agentMessages = mcpRepliesFromSession(messages, session)
		const replySegments = segments.filter((s) => s.containsReply)

		// Pair closed turns' `result` envelopes with the final_output messages
		// already persisted for this session, in order. Anything past that count
		// hasn't landed in the DB yet, so it renders optimistically from the log.
		// Ordinal pairing rather than id matching, for the same reason the reply
		// pairing above uses it: messages.sessionId is null for HTTP-transport MCP.
		const resultSegments = segments.filter((s) => s.result)
		const finalOutputMessages = finalOutputsFromSession(messages, session)
		const persistedFinalCount = finalOutputMessages.length
		const pairedCount = Math.min(replySegments.length, agentMessages.length)
		for (let i = 0; i < pairedCount; i++) {
			const message = agentMessages[i]
			const segment = replySegments[i]
			if (!message || !segment) continue
			const list = byReplyMessageId.get(message.id) ?? []
			list.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: segment.steps,
				inProgress: false,
				...pendingFinalOutputFor(
					segment,
					resultSegments,
					persistedFinalCount,
					session.id,
					pendingFirstSeen.current,
				),
			})
			byReplyMessageId.set(message.id, list)
		}

		// A turn that closed without calling the reply tool produced no MCP
		// message to anchor to, so the pairing above never emitted it — yet it
		// is exactly the turn whose end-of-turn output is now the reply.
		//
		// It is emitted whether or not its output is still pending. Skipping
		// the already-persisted ones would make the whole dropdown — thinking,
		// tool calls, the lot — vanish the instant the agent's message landed,
		// which is precisely when the user wants to look at it.
		const pairedSegments = new Set(replySegments.slice(0, pairedCount))
		for (const segment of resultSegments) {
			if (pairedSegments.has(segment)) continue
			const pending = pendingFinalOutputFor(
				segment,
				resultSegments,
				persistedFinalCount,
				session.id,
				pendingFirstSeen.current,
			)
			const turn: MessageTurnActivity = {
				sessionId: session.id,
				actorId: session.actorId,
				steps: segment.steps,
				inProgress: false,
				...pending,
			}

			// Once the output exists as a real message, anchor the dropdown to
			// it — above the answer it produced, matching how MCP replies pair.
			// Until then there is no such message, so it hangs off the turn's
			// trigger alongside the optimistic bubble.
			const persisted = pending.pendingFinalOutput
				? undefined
				: finalOutputMessages[resultSegments.indexOf(segment)]
			if (persisted) {
				const list = byReplyMessageId.get(persisted.id) ?? []
				list.push(turn)
				byReplyMessageId.set(persisted.id, list)
			} else {
				const list = byTriggerMessageId.get(segment.conversationMessageId) ?? []
				list.push(turn)
				byTriggerMessageId.set(segment.conversationMessageId, list)
			}
		}

		// The live turn is the last segment overall, unless it's already one
		// of the reply segments we just paired off above (already resolved).
		const lastSegment = segments[segments.length - 1]
		const lastSegmentPairedIndex = lastSegment ? replySegments.indexOf(lastSegment) : -1
		const lastSegmentAlreadyPaired =
			lastSegmentPairedIndex !== -1 && lastSegmentPairedIndex < pairedCount

		const lastSegmentEmittedAsFinal =
			lastSegment !== undefined &&
			resultSegments.includes(lastSegment) &&
			!pairedSegments.has(lastSegment)

		if (!idle && lastSegment && !lastSegmentAlreadyPaired && !lastSegmentEmittedAsFinal) {
			const list = byTriggerMessageId.get(lastSegment.conversationMessageId) ?? []
			list.push({
				sessionId: session.id,
				actorId: session.actorId,
				// Keep the steps we already have — they're still the best
				// account of the turn — but stop claiming it's live when we
				// can no longer read the logs that would prove it.
				steps: logsFailed
					? [
							...lastSegment.steps,
							{
								id: `${session.id}-logs-stalled`,
								kind: 'error' as const,
								text: "Couldn't load this turn's activity — retrying.",
							},
						]
					: lastSegment.steps,
				inProgress: !logsFailed,
				...(logsFailed ? { interrupted: true } : {}),
				...pendingFinalOutputFor(
					lastSegment,
					resultSegments,
					persistedFinalCount,
					session.id,
					pendingFirstSeen.current,
				),
			})
			byTriggerMessageId.set(lastSegment.conversationMessageId, list)
		}

		// Still working but nothing tagged yet — either a turn that just
		// started (log rows haven't caught up) or unassigned steps left over
		// from a pre-tagging turn.
		if (!idle && (segments.length === 0 || unassigned.length > 0)) {
			fallback.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: unassigned,
				inProgress: !logsFailed,
				...(logsFailed ? { interrupted: true } : {}),
			})
		}
	}

	// The oldest session whose activity is already loaded — the only one that
	// can have anything before it, since activity within a session is
	// contiguous. `latestSessions` is newest-first (see the route's ordering),
	// so the last watched entry is the oldest.
	const oldestWatched = watchedSessions[watchedSessions.length - 1]
	const nextHistorySession = terminalSessions.find((s) => !historySessionIds.includes(s.id))
	const oldestBackfill = oldestWatched ? backfill.get(oldestWatched.id) : undefined

	const loadOlderActivity = useCallback(() => {
		// Prefer pulling in the next unwatched terminal session — that's a whole
		// session's worth of history, versus one more page of an already-open
		// one. Only page backward once every session is already being read.
		if (nextHistorySession) {
			setHistorySessionIds((prev) =>
				prev.includes(nextHistorySession.id) ? prev : [...prev, nextHistorySession.id],
			)
			return
		}
		if (oldestWatched) void loadOlder(oldestWatched.id)
	}, [nextHistorySession, oldestWatched, loadOlder])

	// How many agent messages in the thread have no activity loaded for them.
	//
	// The existence of an unwatched terminal session is NOT the signal: a chat
	// spawns a fresh session per turn and they go terminal almost immediately,
	// so gating on that put the control on screen after the agent's second
	// message — offering to load history that was already fully on screen.
	// What actually warrants the offer is agent replies whose trace is missing.
	const uncoveredAgentMessages = messages.filter(
		(m) => m.actorType === 'agent' && !byReplyMessageId.has(m.id),
	).length
	const hasMeaningfulHistory = uncoveredAgentMessages >= UNCOVERED_ACTIVITY_THRESHOLD

	const olderActivity = {
		available:
			hasMeaningfulHistory &&
			(Boolean(nextHistorySession) || (oldestBackfill?.hasOlder ?? Boolean(oldestWatched))),
		isLoading: oldestBackfill?.isLoading ?? false,
		exhausted: !nextHistorySession && (oldestBackfill?.exhausted ?? false),
	}

	return { byReplyMessageId, byTriggerMessageId, fallback, loadOlderActivity, olderActivity }
}

/** How long a pending output may go unpersisted before we say so. */
const FINAL_OUTPUT_STALE_MS = 45_000

/**
 * Agent replies without loaded activity before offering to load more.
 *
 * Reaching back is a real cost — a cold page against a permanently-retained
 * log table — so it should be offered when there is genuinely a stretch of
 * history to recover, not on every chat that has run more than one turn.
 */
const UNCOVERED_ACTIVITY_THRESHOLD = 20

/**
 * Decides whether this segment's end-of-turn output should render
 * optimistically, i.e. whether its persisted message has arrived yet.
 *
 * Returns a spreadable partial so callers stay a single object literal.
 */
function pendingFinalOutputFor(
	segment: MessageActivitySegment,
	resultSegments: MessageActivitySegment[],
	persistedFinalCount: number,
	sessionId: string,
	firstSeen: Map<string, number>,
): Pick<MessageTurnActivity, 'pendingFinalOutput'> {
	const result = segment.result
	if (!result) return {}
	// Everything up to `persistedFinalCount` already exists as a real message.
	if (resultSegments.indexOf(segment) < persistedFinalCount) return {}
	// A failed turn's `result` text is the raw API error envelope, not an
	// answer, and the backend never posts it verbatim: it either replays the
	// turn (2s, then 8s, plus the write round-trip) or posts a written
	// explanation. Rendering it optimistically would put `API Error: {...}` in
	// the chat as the agent's reply for the whole of that window — the exact
	// blob this feature exists to keep out — and the transcript's retraction
	// can only take it back afterwards, once the replay envelope lands.
	// Waiting for the persisted message costs a few seconds of silence and is
	// always the message the human should actually read.
	//
	// Note this does not change the ordinal pairing above: the segment still
	// counts in `resultSegments`, only its optimistic render is suppressed.
	if (result.isError) return {}

	const key = `${sessionId}-final-${result.logId}`
	const seenAt = firstSeen.get(key)
	const now = Date.now()
	if (seenAt === undefined) firstSeen.set(key, now)
	const unconfirmed = seenAt !== undefined && now - seenAt > FINAL_OUTPUT_STALE_MS

	return {
		pendingFinalOutput: {
			text: result.text,
			isError: result.isError,
			key,
			...(unconfirmed ? { unconfirmed: true } : {}),
		},
	}
}

/**
 * Messages this actor posted at or after the session started.
 *
 * Scoped by `actorId` + start time rather than `messages.sessionId` for the
 * reason given in useConversationActivity's doc comment — that column is null
 * for HTTP-transport MCP replies, which is most of them.
 */
function messagesFromSession(
	messages: MessageResponse[],
	session: SessionResponse,
): MessageResponse[] {
	const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : null
	return messages.filter((m) => {
		if (m.actorId !== session.actorId) return false
		if (startedAt === null || !m.createdAt) return true
		return new Date(m.createdAt).getTime() >= startedAt
	})
}

/**
 * This session's messages that the agent posted itself, mid-turn, via the
 * post_conversation_message MCP tool.
 *
 * Auto-posted end-of-turn output is excluded: it pairs with a segment's
 * `result`, not with a `containsReply` segment. Counting both in one list
 * would shift the reply pairing by one every turn and anchor each dropdown
 * under the wrong message.
 */
function mcpRepliesFromSession(
	messages: MessageResponse[],
	session: SessionResponse,
): MessageResponse[] {
	return messagesFromSession(messages, session).filter((m) => m.metadata?.source !== 'final_output')
}

/**
 * This session's auto-posted end-of-turn messages, oldest first.
 *
 * Counted against `resultSegments` by ordinal, so this must only include
 * messages that a `result` envelope actually produced. An 'unanswered' retry
 * notice is the one kind that never had one: the backend posts it precisely
 * because the replayed turn never closed, and the transcript has already
 * retracted the failed envelope that opened it (see `segmentActivityByMessage`).
 * Counting it would leave `persistedFinalCount` permanently one ahead, and
 * every later turn in the session would be read as already-persisted — so the
 * agent's end-of-turn text would stop appearing until the next reload.
 *
 * The other retry notices are not excluded, and must not be: 'undeliverable'
 * and 'unavailable' both leave the failed `result` envelope standing as a
 * segment, so they still pair one-to-one.
 */
function finalOutputsFromSession(
	messages: MessageResponse[],
	session: SessionResponse,
): MessageResponse[] {
	return messagesFromSession(messages, session).filter(
		(m) =>
			m.metadata?.source === 'final_output' && m.metadata?.final_output?.retry !== 'unanswered',
	)
}

/**
 * Toasts the same "plan limit reached" message shown when a new session is
 * blocked from starting, but for a session that was already running and got
 * killed mid-conversation by SessionManager's budget watchdog — otherwise an
 * interactive chat session just goes quiet with the reason only visible if
 * the user happens to scroll up and read the inline error notice.
 *
 * Only fires on an observed running→failed transition (tracked per session
 * id in a ref), not for a session that was already in a failed state on
 * first load — opening an old, already-failed conversation shouldn't toast.
 */
export function useSessionBudgetStopToast(
	workspaceId: string,
	conversationId: string | null,
): void {
	const { data: sessions } = useActiveSessionsForConversation(workspaceId, conversationId)
	const navigate = useNavigate()
	const seenStatusRef = useRef<Map<string, string>>(new Map())

	useEffect(() => {
		for (const session of sessions ?? []) {
			const prevStatus = seenStatusRef.current.get(session.id)
			seenStatusRef.current.set(session.id, session.status)
			if (prevStatus === undefined || prevStatus === session.status) continue
			if (session.status !== 'failed' && session.status !== 'timeout') continue
			const reason = parseFailureReason(session.result as Record<string, unknown> | null)
			if (reason?.reason_code !== 'plan_cap_exceeded') continue
			toastSessionBudgetStopped(navigate, workspaceId)
		}
	}, [sessions, navigate, workspaceId])
}
