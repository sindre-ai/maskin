import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import { and, asc, eq, inArray, like } from 'drizzle-orm'

// ── Resuming an agent's CLI transcript after a rewind ────────────────────────
//
// When a conversation is rewound, the agent's live CLI process still holds the
// discarded tail in memory. Ending the session is the only way to make it
// forget — but a cold restart also throws away everything *before* the rewind
// point, leaving the agent to re-read a 15-message history blob instead of its
// real context.
//
// Claude Code can do better: `--resume <cli-session-id> --resume-session-at
// <turn-uuid> --resume-drops-turn <turn-uuid>` reopens the transcript with its
// history truncated at a turn. This module works out *which* turn.
//
// The transcript's own uuids are only readable from inside the sandbox, so we
// don't try to resolve them here. Instead we compute the turn's **ordinal** —
// "the Nth user turn of this CLI session" — which is derivable entirely from
// data apps/dev already owns, and hand that to the sandbox-side resolver
// (docker/agent-base/resolve-resume-turn.mjs) to convert into a uuid.
//
// Ordinals work because every user turn the CLI ever sees is written by
// SessionManager.writeInput, which persists a copy of the envelope stamped with
// `maskin_message_id` into session_logs — including the seed turn
// (launchContainer passes config.conversation.message_id). So the stamped
// envelopes in session_logs are exactly the user turns in the transcript, in
// the same order. Matching on message *text* was the alternative and is
// strictly worse: buildConversationTurnPrompt appends a "(they @mentioned
// you)"-style suffix that varies per delivery.

export interface ResumeTarget {
	/** The uuid handed to that session's CLI via `--session-id`. */
	cliSessionId: string
	/** 1-based index of the target turn among the session's user turns. */
	turnOrdinal: number
}

/** Live interactive session for one agent in a conversation, with its resume target. */
export interface AgentResumeTarget extends ResumeTarget {
	agentId: string
	sessionId: string
}

const ACTIVE_STATUSES = ['pending', 'starting', 'running'] as const

/**
 * Find the live interactive sessions for a conversation and, for each, the
 * transcript turn corresponding to `targetMessageId`.
 *
 * Call this *before* stopping the sessions — it reads their `cliSessionId` and
 * their delivered-turn log.
 *
 * A session is simply omitted when it has no resolvable target (an older
 * session predating `cliSessionId`, or one that never received the target
 * message). The caller then starts that agent cold, which is correct but
 * lossy — never an error.
 */
export async function resolveConversationResumeTargets(
	db: Database,
	conversationId: string,
	targetMessageId: number,
): Promise<AgentResumeTarget[]> {
	const live = await db
		.select({
			id: sessions.id,
			actorId: sessions.actorId,
			cliSessionId: sessions.cliSessionId,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.conversationId, conversationId),
				eq(sessions.interactive, true),
				inArray(sessions.status, [...ACTIVE_STATUSES]),
			),
		)

	const targets: AgentResumeTarget[] = []
	for (const session of live) {
		if (!session.cliSessionId) continue
		const ordinal = await resolveTurnOrdinal(db, session.id, targetMessageId)
		if (ordinal === null) continue
		targets.push({
			agentId: session.actorId,
			sessionId: session.id,
			cliSessionId: session.cliSessionId,
			turnOrdinal: ordinal,
		})
	}
	return targets
}

/**
 * Position of `targetMessageId` among the user turns delivered to a session,
 * 1-based. Returns null when the message was never delivered to it.
 */
export async function resolveTurnOrdinal(
	db: Database,
	sessionId: string,
	targetMessageId: number,
): Promise<number | null> {
	const rows = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				// Narrow in SQL before parsing: a chat session's log is mostly CLI
				// stdout, and only the handful of turn envelopes carry this key.
				like(sessionLogs.content, '%maskin_message_id%'),
			),
		)
		.orderBy(asc(sessionLogs.id))

	let ordinal = 0
	for (const row of rows) {
		const messageId = readStampedMessageId(row.content)
		if (messageId === null) continue
		ordinal++
		if (messageId === targetMessageId) return ordinal
	}
	return null
}

/**
 * Pull `maskin_message_id` out of a persisted turn envelope.
 *
 * Tolerant by design — session_logs is an append-only stream of whatever the
 * CLI and the writer emitted, so a line that merely mentions the key (agent
 * output quoting a log, say) must be skipped rather than throw.
 */
function readStampedMessageId(content: string): number | null {
	try {
		const parsed = JSON.parse(content) as { type?: string; maskin_message_id?: unknown }
		if (parsed.type !== 'user') return null
		return typeof parsed.maskin_message_id === 'number' ? parsed.maskin_message_id : null
	} catch {
		return null
	}
}
