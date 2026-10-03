import type { Database } from '@maskin/db'
import { actors, voiceSessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { trackVoiceSessionEnded } from '../lib/analytics/voice-events'
import type { VoiceEndedReason } from '../lib/analytics/voice-events'
import { computeVoiceCostUsd } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { captureVoiceException } from '../lib/sentry-voice'

/**
 * Terminal path for a voice call. Every way a call can end (hangup route,
 * WS-drop grace, idle sweeper, vendor error, server shutdown) goes through
 * endVoiceSession so the row, the cost, the vendor teardown and the
 * voice_session_ended event cannot drift between paths.
 */

/** Crash floor from the tech spec §Error handling. Pricing Strategist owns the real number. */
export const VOICE_DAILY_MINUTE_CAP = 60
/** How long a dropped event channel may stay away before the call is ended. */
export const VOICE_WS_GRACE_MS = 20_000

const LIVE_STATUSES = ['pending', 'active'] as const

/** Which row status each terminal reason lands in (tech spec §Session lifecycle). */
const STATUS_FOR_REASON: Record<VoiceEndedReason, 'ended' | 'timed_out' | 'errored'> = {
	user_hangup: 'ended',
	network_error: 'ended',
	server_stop: 'ended',
	idle_timeout: 'timed_out',
	vendor_error: 'errored',
}

// ── Live counters ────────────────────────────────────────────────────

interface LiveCounters {
	inputAudioMs: number
	outputAudioMs: number
	turnCount: number
	toolCallsCount: number
}

// In-process on purpose: the event channel, the hangup route and the sweeper
// all run in this one server process, and voice_sessions has no columns for
// turn / tool-call counts. After a restart a session ends with zeroes here and
// falls back to whatever the client reported on hangup.
const liveCounters = new Map<string, LiveCounters>()

function countersFor(sessionId: string): LiveCounters {
	let counters = liveCounters.get(sessionId)
	if (!counters) {
		counters = { inputAudioMs: 0, outputAudioMs: 0, turnCount: 0, toolCallsCount: 0 }
		liveCounters.set(sessionId, counters)
	}
	return counters
}

export function recordVoiceTurn(
	sessionId: string,
	turn: { userAudioMs: number; agentAudioMs: number },
): void {
	const counters = countersFor(sessionId)
	counters.turnCount += 1
	counters.inputAudioMs += turn.userAudioMs
	counters.outputAudioMs += turn.agentAudioMs
}

export function recordVoiceToolCall(sessionId: string): void {
	countersFor(sessionId).toolCallsCount += 1
}

// ── Vendor teardown ──────────────────────────────────────────────────

/**
 * Closes the vendor side of a call. OpenAI documents no server-side close for
 * a Realtime session minted via POST /v1/realtime/sessions: the audio runs
 * browser <-> OpenAI over WebRTC and the 60s ephemeral secret is already spent
 * once the handshake lands, so ending the row is what stops us counting it.
 * The seam stays so a vendor endpoint can be wired in without touching the
 * terminal paths; failures are logged, never thrown.
 */
export type CloseVendorSessionFn = (session: {
	voiceSessionId: string
	vendorSessionId: string | null
}) => Promise<void>

let closeVendorSessionFn: CloseVendorSessionFn = async (session) => {
	logger.debug('Voice vendor session closed (no server-side teardown endpoint)', {
		voice_session_id: session.voiceSessionId,
		vendor_session_id: session.vendorSessionId,
	})
}

export function setCloseVendorSessionFn(fn: CloseVendorSessionFn | null): void {
	closeVendorSessionFn = fn ?? (async () => {})
}

// ── Terminal path ────────────────────────────────────────────────────

export interface EndVoiceSessionInput {
	id: string
	reason: VoiceEndedReason
	/** Audio seconds the client measured. Used when larger than what the event channel recorded. */
	reportedInputAudioSeconds?: number
	reportedOutputAudioSeconds?: number
	vendorErrorCode?: string
}

export type VoiceSessionEnded = typeof voiceSessions.$inferSelect

/**
 * Ends a live call exactly once. The UPDATE only matches rows still pending /
 * active, so a hangup racing the sweeper (or a WS-drop timer firing after the
 * user already hung up) resolves to a single winner; the loser gets null and
 * does nothing, which keeps voice_session_ended to one event per call.
 */
export async function endVoiceSession(
	db: Database,
	input: EndVoiceSessionInput,
): Promise<VoiceSessionEnded | null> {
	cancelVoiceWsGrace(input.id)

	const [live] = await db
		.select({ startedAt: voiceSessions.startedAt })
		.from(voiceSessions)
		.where(and(eq(voiceSessions.id, input.id), inArray(voiceSessions.status, [...LIVE_STATUSES])))
		.limit(1)
	if (!live) return null

	const now = new Date()
	const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - live.startedAt.getTime()) / 1000))
	const counters = liveCounters.get(input.id)
	// Neither side can have carried more audio than the call lasted, so a
	// client-reported figure is clamped to the wall clock.
	const inputAudioSeconds = Math.min(
		elapsedSeconds,
		Math.max(
			Math.round((counters?.inputAudioMs ?? 0) / 1000),
			input.reportedInputAudioSeconds ?? 0,
		),
	)
	const outputAudioSeconds = Math.min(
		elapsedSeconds,
		Math.max(
			Math.round((counters?.outputAudioMs ?? 0) / 1000),
			input.reportedOutputAudioSeconds ?? 0,
		),
	)
	const totalCostUsd = computeVoiceCostUsd(inputAudioSeconds, outputAudioSeconds)

	const [ended] = await db
		.update(voiceSessions)
		.set({
			status: STATUS_FOR_REASON[input.reason],
			endedReason: input.reason,
			endedAt: now,
			inputAudioSeconds,
			outputAudioSeconds,
			totalCostUsd: totalCostUsd.toFixed(6),
		})
		.where(and(eq(voiceSessions.id, input.id), inArray(voiceSessions.status, [...LIVE_STATUSES])))
		.returning()
	if (!ended) return null

	liveCounters.delete(input.id)

	await closeVendorSessionFn({
		voiceSessionId: ended.id,
		vendorSessionId: ended.vendorSessionId,
	}).catch((err) => {
		logger.warn('Voice vendor session close failed', {
			voice_session_id: ended.id,
			error: err instanceof Error ? err.message : String(err),
		})
		captureVoiceException(ended.id, err)
	})

	await emitEnded(db, ended, {
		reason: input.reason,
		durationMs: now.getTime() - ended.startedAt.getTime(),
		inputAudioSeconds,
		outputAudioSeconds,
		totalCostUsd,
		toolCallsCount: counters?.toolCallsCount ?? 0,
		turnCount: counters?.turnCount ?? 0,
	})
	return ended
}

async function emitEnded(
	db: Database,
	session: VoiceSessionEnded,
	stats: {
		reason: VoiceEndedReason
		durationMs: number
		inputAudioSeconds: number
		outputAudioSeconds: number
		totalCostUsd: number
		toolCallsCount: number
		turnCount: number
	},
): Promise<void> {
	try {
		const [agent] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, session.agentActorId))
			.limit(1)
		await trackVoiceSessionEnded(session.humanActorId, {
			voice_session_id: session.id,
			agent_id: session.agentActorId,
			agent_name: agent?.name ?? '',
			workspace_id: session.workspaceId,
			conversation_id: session.conversationId,
			model: session.model ?? '',
			vendor: 'openai_realtime',
			duration_ms: stats.durationMs,
			ended_reason: stats.reason,
			input_audio_seconds: stats.inputAudioSeconds,
			output_audio_seconds: stats.outputAudioSeconds,
			total_cost_usd: stats.totalCostUsd,
			tool_calls_count: stats.toolCallsCount,
			turn_count: stats.turnCount,
		})
	} catch (err) {
		// Analytics must never undo a call that has already been closed.
		logger.warn('voice_session_ended capture failed', {
			voice_session_id: session.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

// ── WS-drop grace ────────────────────────────────────────────────────

const graceTimers = new Map<string, NodeJS.Timeout>()

/**
 * Called when a call's event channel closes without the call having ended.
 * If the browser does not reconnect within the grace, the call is ended as
 * network_error. A reconnect (or any other terminal path) cancels it.
 */
export function startVoiceWsGrace(
	db: Database,
	voiceSessionId: string,
	graceMs: number = VOICE_WS_GRACE_MS,
): void {
	cancelVoiceWsGrace(voiceSessionId)
	const timer = setTimeout(() => {
		graceTimers.delete(voiceSessionId)
		endVoiceSession(db, { id: voiceSessionId, reason: 'network_error' }).catch((err) => {
			logger.error('Voice WS-drop grace end failed', {
				voice_session_id: voiceSessionId,
				error: err instanceof Error ? err.message : String(err),
			})
			captureVoiceException(voiceSessionId, err)
		})
	}, graceMs)
	timer.unref()
	graceTimers.set(voiceSessionId, timer)
}

export function cancelVoiceWsGrace(voiceSessionId: string): void {
	const timer = graceTimers.get(voiceSessionId)
	if (timer) {
		clearTimeout(timer)
		graceTimers.delete(voiceSessionId)
	}
}

// ── Daily minute cap ─────────────────────────────────────────────────

function startOfUtcDay(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Minutes of voice a workspace has used since 00:00 UTC. Wall-clock call
 * duration (a live call counts up to now), because that is what the cap is
 * protecting: spend on the operator's vendor key.
 */
export async function getVoiceMinutesUsedToday(
	db: Database,
	workspaceId: string,
	now: Date = new Date(),
): Promise<number> {
	const [row] = await db
		.select({
			seconds: sql<string>`coalesce(sum(extract(epoch from (coalesce(${voiceSessions.endedAt}, now()) - ${voiceSessions.startedAt}))), 0)`,
		})
		.from(voiceSessions)
		.where(
			and(
				eq(voiceSessions.workspaceId, workspaceId),
				sql`${voiceSessions.startedAt} >= ${startOfUtcDay(now).toISOString()}::timestamptz`,
			),
		)
	const seconds = Number(row?.seconds ?? 0)
	return Number.isFinite(seconds) ? seconds / 60 : 0
}

/** Seconds until the daily window resets (next 00:00 UTC), at least 1. */
export function secondsUntilVoiceCapResets(now: Date = new Date()): number {
	const next = startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000
	return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}
