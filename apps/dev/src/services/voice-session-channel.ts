import type { Database } from '@maskin/db'
import { UnknownToolError, VoiceToolNotAllowedError, parseVoiceToolArgs } from '@maskin/mcp'
import type { InvokeTool } from '@maskin/mcp'
import { z } from 'zod'
import { captureVoiceToolCall, captureVoiceTurnCompleted } from '../lib/analytics/voice-events'
import { logger } from '../lib/logger'
import {
	type VoiceSessionRow,
	isTranscriptPersistenceEnabled,
	writeVoiceTranscriptLine,
} from './voice-transcript'

/**
 * Per-connection logic for GET /api/voice-sessions/:id/events, kept apart from
 * the WebSocket transport so it can be driven directly in tests.
 *
 * Wire protocol (JSON text frames):
 *
 *   browser → server
 *     tool_call       { call_id, name, arguments }   forwarded from the Realtime
 *                                                    response.function_call_arguments.done
 *     transcript      { role, text }                 one finished user / assistant turn
 *     turn_completed  { turn_index, user_audio_ms, agent_audio_ms, barge_in }
 *
 *   server → browser
 *     ready           { persist_transcripts, conversation_id }
 *     tool_result     { call_id, name, ok, error_code, event }   event is the
 *                     Realtime conversation.item.create (function_call_output) the
 *                     browser relays verbatim over its DataChannel, followed by a
 *                     response.create so the model speaks the result
 *     conversation    { conversation_id }            first time a transcript line
 *                                                    landed in a conversation
 *     error           { code }
 */

/** Largest inbound frame we parse. A spoken turn or a tool call's arguments are far below this. */
export const VOICE_MAX_FRAME_BYTES = 256 * 1024
/** Cap on a tool result handed back to the model, so one huge read cannot flood a Realtime turn. */
export const VOICE_MAX_TOOL_OUTPUT_CHARS = 20_000

const clientMessageSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('tool_call'),
		call_id: z.string().min(1).max(200),
		name: z.string().min(1).max(100),
		arguments: z.union([z.string().max(100_000), z.record(z.unknown())]).default('{}'),
	}),
	z.object({
		type: z.literal('transcript'),
		role: z.enum(['user', 'assistant']),
		text: z.string().max(50_000),
	}),
	z.object({
		type: z.literal('turn_completed'),
		turn_index: z.number().int().min(0),
		user_audio_ms: z.number().min(0),
		agent_audio_ms: z.number().min(0),
		barge_in: z.boolean(),
	}),
])

export type VoiceServerMessage =
	| { type: 'ready'; persist_transcripts: boolean; conversation_id: string | null }
	| {
			type: 'tool_result'
			call_id: string
			name: string
			ok: boolean
			error_code: string | null
			event: { type: 'conversation.item.create'; item: Record<string, unknown> }
	  }
	| { type: 'conversation'; conversation_id: string }
	| { type: 'error'; code: string }

export interface VoiceChannelDeps {
	db: Database
	session: VoiceSessionRow
	agentName: string
	invokeTool: InvokeTool
	send: (message: VoiceServerMessage) => void
	now?: () => number
}

export interface VoiceChannel {
	onOpen(): Promise<void>
	onMessage(raw: unknown): Promise<void>
	/** Resolves once every transcript line queued so far has been written. */
	idle(): Promise<void>
}

function toolResultText(result: unknown): { text: string; isError: boolean } {
	const r = result as {
		content?: Array<{ type?: string; text?: string }>
		isError?: boolean
	} | null
	const text = Array.isArray(r?.content)
		? r.content
				.filter((part) => part?.type === 'text' && typeof part.text === 'string')
				.map((part) => part.text)
				.join('\n')
		: JSON.stringify(result ?? null)
	return { text, isError: r?.isError === true }
}

function cap(text: string): string {
	return text.length > VOICE_MAX_TOOL_OUTPUT_CHARS
		? `${text.slice(0, VOICE_MAX_TOOL_OUTPUT_CHARS)}… [truncated]`
		: text
}

export function createVoiceChannel(deps: VoiceChannelDeps): VoiceChannel {
	const { db, session, agentName, invokeTool, send } = deps
	const now = deps.now ?? Date.now
	let knownConversationId = session.conversationId
	// Transcript lines are written one at a time, in arrival order: lines must
	// land in message-id order, and the first one lazily creates the
	// conversation, which two concurrent writes would race on.
	let transcriptQueue: Promise<void> = Promise.resolve()

	async function handleToolCall(
		msg: Extract<z.infer<typeof clientMessageSchema>, { type: 'tool_call' }>,
	) {
		const startedAt = now()
		let ok = false
		let errorCode: string | null = null
		let output: string
		try {
			let rawArgs: unknown
			try {
				rawArgs =
					typeof msg.arguments === 'string' ? JSON.parse(msg.arguments || '{}') : msg.arguments
			} catch {
				rawArgs = null
			}
			const args = parseVoiceToolArgs(msg.name, rawArgs, session.workspaceId)
			const result = await invokeTool(msg.name, args, {
				actorId: session.agentActorId,
				workspaceId: session.workspaceId,
			})
			const { text, isError } = toolResultText(result)
			if (isError) {
				errorCode = 'voice_tool_failed'
				output = JSON.stringify({ error: cap(text), error_code: errorCode })
			} else {
				ok = true
				output = cap(text)
			}
		} catch (err) {
			if (err instanceof VoiceToolNotAllowedError) {
				errorCode = err.code
				output = JSON.stringify({ error: err.message, error_code: err.code })
			} else if (err instanceof UnknownToolError) {
				errorCode = 'voice_tool_not_allowed'
				output = JSON.stringify({ error: err.message, error_code: errorCode })
			} else {
				errorCode = 'voice_tool_failed'
				logger.error('Voice tool call failed', {
					voice_session_id: session.id,
					tool_name: msg.name,
					error: err instanceof Error ? err.message : String(err),
				})
				output = JSON.stringify({
					error: `The ${msg.name} call failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
					error_code: errorCode,
				})
			}
		}

		send({
			type: 'tool_result',
			call_id: msg.call_id,
			name: msg.name,
			ok,
			error_code: errorCode,
			event: {
				type: 'conversation.item.create',
				item: { type: 'function_call_output', call_id: msg.call_id, output },
			},
		})
		void captureVoiceToolCall(session.humanActorId, {
			voice_session_id: session.id,
			tool_name: msg.name,
			success: ok,
			latency_ms: now() - startedAt,
			error_code: errorCode,
		})
	}

	function enqueueTranscript(role: 'user' | 'assistant', text: string) {
		transcriptQueue = transcriptQueue.then(async () => {
			try {
				const written = await writeVoiceTranscriptLine(db, { session, agentName, role, text })
				if (written && written.conversationId !== knownConversationId) {
					knownConversationId = written.conversationId
					send({ type: 'conversation', conversation_id: written.conversationId })
				}
			} catch (err) {
				logger.error('Voice transcript write failed', {
					voice_session_id: session.id,
					error: err instanceof Error ? err.message : String(err),
				})
				send({ type: 'error', code: 'voice_transcript_failed' })
			}
		})
	}

	return {
		async onOpen() {
			send({
				type: 'ready',
				persist_transcripts: await isTranscriptPersistenceEnabled(db, session.workspaceId),
				conversation_id: knownConversationId,
			})
		},

		async onMessage(raw) {
			if (typeof raw !== 'string' || raw.length > VOICE_MAX_FRAME_BYTES) {
				send({ type: 'error', code: 'voice_invalid_message' })
				return
			}
			let json: unknown
			try {
				json = JSON.parse(raw)
			} catch {
				send({ type: 'error', code: 'voice_invalid_message' })
				return
			}
			const parsed = clientMessageSchema.safeParse(json)
			if (!parsed.success) {
				send({ type: 'error', code: 'voice_invalid_message' })
				return
			}
			const msg = parsed.data
			switch (msg.type) {
				case 'tool_call':
					await handleToolCall(msg)
					return
				case 'transcript':
					enqueueTranscript(msg.role, msg.text)
					return
				case 'turn_completed':
					void captureVoiceTurnCompleted(session.humanActorId, {
						voice_session_id: session.id,
						turn_index: msg.turn_index,
						user_audio_ms: msg.user_audio_ms,
						agent_audio_ms: msg.agent_audio_ms,
						barge_in: msg.barge_in,
					})
					return
			}
		},

		idle: () => transcriptQueue,
	}
}
