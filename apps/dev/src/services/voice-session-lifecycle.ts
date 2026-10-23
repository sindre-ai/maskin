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
 * server-socket drop, idle sweeper, vendor error, server shutdown) goes through
 * endVoiceSession so the row, the cost, the vendor teardown and the
 * voice_session_ended event cannot drift between paths.
 */

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

// Written to the voice_sessions row as the call runs, not held in memory, so a
// server restart mid-call does not zero them. Only rows still pending / active
// are touched: a late event after the call ended is dropped.
export async function recordVoiceTurn(
	db: Database,
	sessionId: string,
	turn: { userAudioMs: number; agentAudioMs: number },
): Promise<void> {
	await db
		.update(voiceSessions)
		.set({
			turnCount: sql`${voiceSessions.turnCount} + 1`,
			inputAudioMs: sql`${voiceSessions.inputAudioMs} + ${Math.max(0, Math.round(turn.userAudioMs))}`,
			outputAudioMs: sql`${voiceSessions.outputAudioMs} + ${Math.max(0, Math.round(turn.agentAudioMs))}`,
		})
		.where(and(eq(voiceSessions.id, sessionId), inArray(voiceSessions.status, [...LIVE_STATUSES])))
}

export async function recordVoiceToolCall(db: Database, sessionId: string): Promise<void> {
	await db
		.update(voiceSessions)
		.set({ toolCallsCount: sql`${voiceSessions.toolCallsCount} + 1` })
		.where(and(eq(voiceSessions.id, sessionId), inArray(voiceSessions.status, [...LIVE_STATUSES])))
}

// ── Vendor teardown ──────────────────────────────────────────────────

/**
 * Closes the vendor side of a call. routes/voice-sessions.ts wires this to
 * closeVoiceCall (services/voice-realtime-call.ts), which closes the server
 * socket and hangs the call up at OpenAI. The default only logs, for callers
 * (tests, scripts) that load this module without the route. Failures are
 * logged, never thrown.
 */
export type CloseVendorSessionFn = (session: {
	voiceSessionId: string
	vendorSessionId: string | null
}) => Promise<void>

let closeVendorSessionFn: CloseVendorSessionFn = async (session) => {
	logger.debug('Voice vendor session closed (no teardown wired)', {
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
	/** Audio seconds the client measured. Only a fallback, used when the event channel recorded no audio for that direction. */
	reportedInputAudioSeconds?: number
	reportedOutputAudioSeconds?: number
	vendorErrorCode?: string
}

export type VoiceSessionEnded = typeof voiceSessions.$inferSelect

/**
 * Ends a live call exactly once. The UPDATE only matches rows still pending /
 * active, so a hangup racing the sweeper (or a socket-drop end firing after the
 * user already hung up) resolves to a single winner; the loser gets null and
 * does nothing, which keeps voice_session_ended to one event per call.
 */
export async function endVoiceSession(
	db: Database,
	input: EndVoiceSessionInput,
): Promise<VoiceSessionEnded | null> {
	const [live] = await db
		.select({
			startedAt: voiceSessions.startedAt,
			inputAudioMs: voiceSessions.inputAudioMs,
			outputAudioMs: voiceSessions.outputAudioMs,
		})
		.from(voiceSessions)
		.where(and(eq(voiceSessions.id, input.id), inArray(voiceSessions.status, [...LIVE_STATUSES])))
		.limit(1)
	if (!live) return null

	const now = new Date()
	const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - live.startedAt.getTime()) / 1000))
	// Neither side can have carried more audio than the call lasted, so the
	// figure is clamped to the wall clock. What the server recorded wins; the
	// client report is used only for a direction with nothing recorded.
	const audioSeconds = (recordedMs: number, reported: number | undefined) =>
		Math.min(
			elapsedSeconds,
			recordedMs > 0 ? Math.round(recordedMs / 1000) : Math.max(0, reported ?? 0),
		)
	const inputAudioSeconds = audioSeconds(live.inputAudioMs, input.reportedInputAudioSeconds)
	const outputAudioSeconds = audioSeconds(live.outputAudioMs, input.reportedOutputAudioSeconds)
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
		toolCallsCount: ended.toolCallsCount,
		turnCount: ended.turnCount,
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
