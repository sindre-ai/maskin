import type { Database } from '@maskin/db'
import { voiceToolCalls } from '@maskin/db/schema'
import { and, asc, eq, gt, or } from 'drizzle-orm'
import { logger } from '../lib/logger'
import {
	capErrorMessage,
	previewToolOutput,
	summarizeToolArgs,
} from '../lib/voice-tool-call-redaction'

export interface VoiceToolCallLogInput {
	voiceSessionId: string
	workspaceId: string
	callId: string | null
	startedAt: Date
	toolName: string
	/** The arguments as the model sent them, before any repair. Redacted here. */
	args: unknown
	success: boolean
	errorCode: string | null
	errorMessage: string | null
	/** Length of the tool output before voice's cap. */
	outputChars: number
	outputTruncated: boolean
	latencyMs: number
	/** What the model was given, after the cap. Redacted and cut here. */
	output: string
}

const clampInt = (n: number) => Math.max(0, Math.min(Math.trunc(Number(n) || 0), 2_147_483_647))

/**
 * Writes one row. Never throws and is not meant to be awaited on the tool call's
 * path: a log that cannot be written is logged and dropped, because the call it
 * describes has already happened. Redaction runs inside the try, so a value it
 * cannot handle loses the row, not the call.
 */
export async function recordVoiceToolCallLog(
	db: Database,
	input: VoiceToolCallLogInput,
): Promise<void> {
	try {
		await db.insert(voiceToolCalls).values({
			voiceSessionId: input.voiceSessionId,
			workspaceId: input.workspaceId,
			callId: input.callId?.slice(0, 200) ?? null,
			startedAt: input.startedAt,
			toolName: input.toolName.slice(0, 100),
			argsSummary: summarizeToolArgs(input.args),
			success: input.success,
			errorCode: input.errorCode,
			errorMessage: capErrorMessage(input.errorMessage),
			outputChars: clampInt(input.outputChars),
			outputTruncated: input.outputTruncated,
			latencyMs: clampInt(input.latencyMs),
			outputPreview: previewToolOutput(input.output),
		})
	} catch (err) {
		logger.warn('Voice tool call log write failed', {
			voice_session_id: input.voiceSessionId,
			tool_name: input.toolName,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

export interface VoiceToolCallCursor {
	startedAt: Date
	id: string
}

/** Keyset page of a call's tool calls, oldest first. */
export async function listVoiceToolCalls(
	db: Database,
	args: {
		voiceSessionId: string
		workspaceId: string
		limit: number
		after: VoiceToolCallCursor | null
	},
) {
	const where = and(
		eq(voiceToolCalls.voiceSessionId, args.voiceSessionId),
		eq(voiceToolCalls.workspaceId, args.workspaceId),
		args.after
			? or(
					gt(voiceToolCalls.startedAt, args.after.startedAt),
					and(
						eq(voiceToolCalls.startedAt, args.after.startedAt),
						gt(voiceToolCalls.id, args.after.id),
					),
				)
			: undefined,
	)
	return db
		.select()
		.from(voiceToolCalls)
		.where(where)
		.orderBy(asc(voiceToolCalls.startedAt), asc(voiceToolCalls.id))
		.limit(args.limit)
}
