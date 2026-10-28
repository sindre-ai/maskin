import type { Database } from '@maskin/db'
import type { InvokeTool } from '@maskin/mcp'
import { z } from 'zod'
import {
	captureForYouCardActionByVoice,
	captureVoiceToolCall,
	captureVoiceTurnCompleted,
} from '../lib/analytics/voice-events'
import { logger } from '../lib/logger'
import { captureVoiceException } from '../lib/sentry-voice'
import {
	type VoiceCallState,
	cardIdOf,
	matchStartCard,
	noteCardNamed,
	voiceCallState,
} from './voice-call-state'
import {
	type HoldPreview,
	buildHoldPreview,
	formatHoldPreviewForModel,
	postHoldPreview,
	readAloudInstruction,
} from './voice-hold-preview'
import { repairToolIdArgs } from './voice-id-resolution'
import {
	type ReceiptDraft,
	type ReceiptOutcome,
	type ReceiptSendInfo,
	describeToolCall,
	notDoneDraft,
	postReceiptLine,
	targetIdsOf,
} from './voice-receipt'
import { endVoiceSession, recordVoiceToolCall, recordVoiceTurn } from './voice-session-lifecycle'
import { VOICE_SHOW_IN_CHAT_TOOL, VoiceShowInChatError, showInChat } from './voice-show-in-chat'
import {
	type VoiceSessionRow,
	isTranscriptPersistenceEnabled,
	writeVoiceTranscriptLine,
} from './voice-transcript'
import {
	type HoldEnd,
	VOICE_CONFIRM_ARG,
	type WriteReview,
	createWriteGate,
} from './voice-write-gate'

/**
 * Per-call logic for the server's socket to a Realtime call (see
 * services/voice-realtime-call.ts, which turns Realtime events into the frames
 * below and sends tool_result.event back), kept apart from the transport so it
 * can be driven directly in tests.
 *
 * Wire protocol (JSON text frames):
 *
 *   browser → server
 *     tool_call       { call_id, name, arguments }   forwarded from the Realtime
 *                                                    response.function_call_arguments.done
 *     transcript      { role, text, item_id? }       one finished user / assistant turn
 *     user_speech_started { item_id? }               the person began speaking
 *     turn_completed  { turn_index, user_audio_ms, agent_audio_ms, barge_in }
 *     vendor_error    { code, message }              an error event relayed from the Realtime
 *                                                    DataChannel; ends the call as errored
 *
 *   server → browser
 *     ready           { persist_transcripts, conversation_id }
 *     tool_result     { call_id, name, ok, error_code, event }   a write is not run
 *                     here until the person has said yes (voice-write-gate.ts);
 *                     the result then tells the model to ask. event is the
 *                     Realtime conversation.item.create (function_call_output) the
 *                     browser relays verbatim over its DataChannel, followed by a
 *                     response.create so the model speaks the result
 *     conversation    { conversation_id }            first time a transcript line
 *                                                    landed in a conversation
 *     ended           { reason }                     the call was ended server-side; tear down
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
		item_id: z.string().max(200).optional(),
	}),
	z.object({
		type: z.literal('user_speech_started'),
		item_id: z.string().max(200).optional(),
	}),
	z.object({
		type: z.literal('vendor_error'),
		code: z.string().max(200).default('unknown'),
		message: z.string().max(2_000).default(''),
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
	| { type: 'ended'; reason: string }
	| { type: 'error'; code: string }

export interface VoiceChannelDeps {
	db: Database
	session: VoiceSessionRow
	agentName: string
	invokeTool: InvokeTool
	/** True for a tool that only reads. Every other tool is held until the person says yes. */
	isReadOnlyTool: (name: string) => boolean
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
		structuredContent?: unknown
		isError?: boolean
	} | null
	let text = Array.isArray(r?.content)
		? r.content
				.filter((part) => part?.type === 'text' && typeof part.text === 'string')
				.map((part) => part.text)
				.join('\n')
		: JSON.stringify(result ?? null)
	// list_actors answers in structuredContent only. The MCP client fills the
	// missing content with [], so text alone would give the model an empty string.
	if (text === '' && r?.structuredContent != null) text = JSON.stringify(r.structuredContent)
	return { text, isError: r?.isError === true }
}

function cap(text: string): string {
	return text.length > VOICE_MAX_TOOL_OUTPUT_CHARS
		? `${text.slice(0, VOICE_MAX_TOOL_OUTPUT_CHARS)}… [truncated]`
		: text
}

function heldMessage(
	tool: string,
	review: Exclude<WriteReview, { kind: 'run' }>,
	inChat: boolean,
): string {
	if (review.kind === 'refuse') {
		return review.reason === 'declined'
			? `The person said no, so ${tool} was not run. Do not call it again unless they ask for it.`
			: `${tool} was not run: no yes from the person was heard after you asked. Ask them again, wait for their answer, then repeat the same call.`
	}
	const target = review.risky
		? ' This one is risky: say exactly what it will affect (who gets it, what is removed or run) and what will happen.'
		: ''
	const changed = review.changed
		? ' The text changed after the person was asked, so their earlier yes does not count for it. Tell them it changed.'
		: ''
	const preview = review.preview
		? `\n\n${formatHoldPreviewForModel(review.preview)}\n\n${readAloudInstruction(review.preview, inChat)}`
		: '\n\nNo preview could be made for this call. Say in one plain sentence what you are about to do and that you cannot read out the exact text, then ask once for a yes.'
	return `Not done yet. ${tool} reaches outside the workspace or cannot easily be undone, so the person has to say yes first. What it will do is below: tell them as the instruction below says, ask for a yes, and wait for their answer.${target}${changed} If they say yes, call ${tool} again with the same arguments plus ${VOICE_CONFIRM_ARG} "${review.id}". If they say no, do not call it again. A yes only counts if the person says it out loud after your question.${preview}`
}

export function createVoiceChannel(deps: VoiceChannelDeps): VoiceChannel {
	const { db, session, agentName, invokeTool, send } = deps
	const now = deps.now ?? Date.now
	const callState: VoiceCallState = voiceCallState(session.id)
	const writeGate = createWriteGate({
		voiceSessionId: session.id,
		isReadOnlyTool: deps.isReadOnlyTool,
		previewFor: (tool, args) =>
			buildHoldPreview({ db, workspaceId: session.workspaceId, tool, args }),
		onHoldEnded: (end) => noteHoldEnded(end),
	})
	callState.pendingHold = () => writeGate.pendingHold()
	let knownConversationId = session.conversationId
	// Transcript lines are written one at a time, in arrival order: lines must
	// land in message-id order, and the first one lazily creates the
	// conversation, which two concurrent writes would race on.
	let transcriptQueue: Promise<void> = Promise.resolve()

	// A failed counter write is logged, never thrown: it must not drop the call.
	async function recordCounter(voiceSessionId: string, write: () => Promise<void>) {
		try {
			await write()
		} catch (err) {
			logger.warn('Voice counter write failed', {
				voice_session_id: voiceSessionId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	// The held text goes into the call's chat as well as being read out. A failure here is logged,
	// never thrown: the hold still works, and the model is then told to read the text out in full.
	async function showHoldInChat(preview: HoldPreview): Promise<boolean> {
		try {
			const conversationId = await postHoldPreview({ db, session, agentName, preview })
			if (conversationId !== knownConversationId) {
				knownConversationId = conversationId
				send({ type: 'conversation', conversation_id: conversationId })
			}
			return true
		} catch (err) {
			logger.warn('Voice hold preview could not be posted to the chat', {
				voice_session_id: session.id,
				error: err instanceof Error ? err.message : String(err),
			})
			return false
		}
	}

	// One line in the call's chat for what a tool call did. A failure here is logged, never thrown:
	// the call itself must carry on, and the closing receipt is built from the lines that did land.
	async function postReceipt(
		tool: string,
		draft: ReceiptDraft,
		outcome: ReceiptOutcome,
		extra: { reason?: string; send?: ReceiptSendInfo; cardId?: string | null } = {},
	) {
		try {
			const conversationId = await postReceiptLine({
				db,
				session,
				agentName,
				tool,
				draft,
				outcome,
				nowMs: now(),
				...extra,
			})
			if (conversationId !== knownConversationId) {
				knownConversationId = conversationId
				send({ type: 'conversation', conversation_id: conversationId })
			}
		} catch (err) {
			logger.warn('Voice receipt line could not be posted', {
				voice_session_id: session.id,
				tool_name: tool,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	// A hold that ended without running (turned down, timed out, replaced by another request) is a
	// write that was not done. A hold replaced by the same send asked again (same tool, same
	// arguments) is not: it carries on. Another send with the same tool is a different write.
	function noteHoldEnded(end: HoldEnd) {
		if (
			end.state === 'superseded' &&
			end.replacedByTool === end.tool &&
			end.replacedByArgsKey === end.argsKey
		) {
			return
		}
		const reason =
			end.state === 'declined'
				? 'You said no.'
				: end.state === 'expired'
					? 'No yes was heard in time.'
					: 'It was replaced by a newer request.'
		const pending = postReceipt(end.tool, notDoneDraft(end.summary), 'not_done', {
			reason,
			send: { yesCount: end.yesCount, readBackMatches: null },
		})
		callState.inflight.add(pending)
		void pending.finally(() => callState.inflight.delete(pending))
	}

	// The lines a finished tool call earns: one per object written, plus an "opened task" line for
	// a single task the person asked to open. Reads of anything else leave no line.
	async function recordToolReceipt(
		toolName: string,
		args: Record<string, unknown>,
		outcome: ReceiptOutcome,
		detail: { resultText: string | null; reason?: string; send?: ReceiptSendInfo },
	) {
		const readOnly = deps.isReadOnlyTool(toolName)
		if (readOnly && (toolName !== 'get_objects' || outcome !== 'ran')) return
		let drafts: ReceiptDraft[]
		try {
			drafts = await describeToolCall({
				db,
				workspaceId: session.workspaceId,
				tool: toolName,
				args,
				resultText: detail.resultText,
				state: callState,
			})
		} catch (err) {
			logger.warn('Voice receipt could not describe a tool call', {
				voice_session_id: session.id,
				tool_name: toolName,
				error: err instanceof Error ? err.message : String(err),
			})
			return
		}
		const targets = targetIdsOf(args)
		for (const draft of drafts) {
			// One item of a batch can fail inside a call that otherwise ran.
			const lineOutcome = draft.outcome ?? outcome
			const ids = draft.objectId ? [draft.objectId] : targets
			const card = lineOutcome === 'ran' && !readOnly ? matchStartCard(callState, ids) : null
			if (lineOutcome === 'ran') noteCardNamed(callState, ids)
			const cardId = card ? cardIdOf(card) : null
			await postReceipt(toolName, draft, lineOutcome, {
				reason: draft.reason ?? detail.reason,
				send: detail.send,
				cardId,
			})
			if (card && cardId) {
				void captureForYouCardActionByVoice(session.humanActorId, {
					voice_session_id: session.id,
					workspace_id: session.workspaceId,
					card_id: cardId,
					card_kind: card.source === 'decision' ? 'decision' : 'thread',
					action_id: toolName,
				})
			}
		}
	}

	async function handleToolCall(
		msg: Extract<z.infer<typeof clientMessageSchema>, { type: 'tool_call' }>,
	) {
		const startedAt = now()
		let ok = false
		let errorCode: string | null = null
		let output: string
		// What the receipt needs once the call is over.
		let receiptArgs: Record<string, unknown> | null = null
		let receiptResultText: string | null = null
		let receiptReason: string | undefined
		let receiptSend: ReceiptSendInfo | undefined
		let receiptState: 'ran' | 'failed' | 'skip' = 'skip'
		try {
			let rawArgs: unknown
			try {
				rawArgs =
					typeof msg.arguments === 'string' ? JSON.parse(msg.arguments || '{}') : msg.arguments
			} catch {
				rawArgs = null
			}
			if (rawArgs == null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
				throw new Error(`Arguments for ${msg.name} must be a JSON object.`)
			}
			// Same call a chat agent makes. The call's workspace is applied last, so a
			// workspace_id the model passes can never point a tool at another workspace.
			const { [VOICE_CONFIRM_ARG]: confirmation, ...toolArgs } = rawArgs as Record<string, unknown>
			const startCards = callState.startCards
			// A garbled or shortened id is repaired when exactly one object fits; otherwise untouched.
			const repaired =
				msg.name === VOICE_SHOW_IN_CHAT_TOOL
					? toolArgs
					: await repairToolIdArgs(db, session.workspaceId, toolArgs, startCards).catch(
							() => toolArgs,
						)
			const args = { ...repaired, workspace_id: session.workspaceId }
			receiptArgs = args
			if (msg.name === VOICE_SHOW_IN_CHAT_TOOL) {
				// Handled here, not by the MCP server: it only ever writes into this call's own chat.
				try {
					const shown = await showInChat({ db, session, agentName, args: toolArgs, startCards })
					if (shown.conversationId !== knownConversationId) {
						knownConversationId = shown.conversationId
						send({ type: 'conversation', conversation_id: shown.conversationId })
					}
					ok = true
					output = JSON.stringify({ shown: true })
					// The resolved ids, not what the model typed, so a repaired id still counts as the card.
					noteCardNamed(callState, shown.objectIds)
				} catch (err) {
					if (!(err instanceof VoiceShowInChatError)) throw err
					errorCode = 'voice_tool_failed'
					output = JSON.stringify({
						error: err.message,
						error_code: errorCode,
						shown: false,
						...(err.detail.unresolvedIds ? { unresolved_ids: err.detail.unresolvedIds } : {}),
						...(err.detail.say ? { say: err.detail.say } : {}),
					})
				}
			} else {
				const review = await writeGate.review(
					msg.name,
					args,
					typeof confirmation === 'string' ? confirmation : null,
				)
				if (review.kind !== 'run') {
					errorCode =
						review.kind === 'hold' ? 'voice_confirmation_required' : 'voice_confirmation_missing'
					const inChat =
						review.kind === 'hold' && review.preview ? await showHoldInChat(review.preview) : false
					output = JSON.stringify({
						error: heldMessage(msg.name, review, inChat),
						error_code: errorCode,
					})
				} else {
					const result = await invokeTool(msg.name, args, {
						actorId: session.agentActorId,
						workspaceId: session.workspaceId,
					})
					const { text, isError } = toolResultText(result)
					if (review.confirmed) {
						receiptSend = {
							yesCount: review.confirmed.yesCount,
							readBackMatches: review.confirmed.readBackMatches,
						}
					}
					if (isError) {
						errorCode = 'voice_tool_failed'
						output = JSON.stringify({ error: cap(text), error_code: errorCode })
						receiptState = 'failed'
						receiptReason = text
					} else {
						ok = true
						output = cap(text)
						receiptState = 'ran'
						receiptResultText = text
					}
				}
			}
		} catch (err) {
			errorCode = 'voice_tool_failed'
			if (receiptArgs && msg.name !== VOICE_SHOW_IN_CHAT_TOOL) {
				receiptState = 'failed'
				receiptReason = err instanceof Error ? err.message : String(err)
			}
			logger.error('Voice tool call failed', {
				voice_session_id: session.id,
				tool_name: msg.name,
				error: err instanceof Error ? err.message : String(err),
			})
			captureVoiceException(session.id, err)
			output = JSON.stringify({
				error: `The ${msg.name} call failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
				error_code: errorCode,
			})
		}

		// The line goes in before the model hears the result, so it is there when a hangup follows.
		if (receiptArgs && receiptState !== 'skip') {
			const pending = recordToolReceipt(msg.name, receiptArgs, receiptState, {
				resultText: receiptResultText,
				reason: receiptReason,
				send: receiptSend,
			})
			callState.inflight.add(pending)
			try {
				await pending
			} finally {
				callState.inflight.delete(pending)
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
		const latencyMs = now() - startedAt
		logger.info('Voice tool call', {
			voice_session_id: session.id,
			tool_name: msg.name,
			ok,
			error_code: errorCode,
			output_chars: output.length,
			latency_ms: latencyMs,
		})
		if (output === '') {
			logger.warn('Voice tool call returned an empty result', {
				voice_session_id: session.id,
				tool_name: msg.name,
			})
		}
		await recordCounter(session.id, () => recordVoiceToolCall(db, session.id))
		void captureVoiceToolCall(session.humanActorId, {
			voice_session_id: session.id,
			tool_name: msg.name,
			success: ok,
			latency_ms: latencyMs,
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
					if (msg.role === 'user') writeGate.noteUserLine(msg.text, msg.item_id)
					enqueueTranscript(msg.role, msg.text)
					return
				case 'user_speech_started':
					writeGate.noteSpeechStarted(msg.item_id)
					return
				case 'vendor_error': {
					// The browser relays the Realtime `error` event; the vendor has
					// already given up on the call, so end it as errored.
					const vendorError = new Error(
						`Voice vendor error ${msg.code}: ${msg.message}`.slice(0, 500),
					)
					logger.error('Voice vendor error', {
						voice_session_id: session.id,
						vendor_error_code: msg.code,
					})
					captureVoiceException(session.id, vendorError)
					const ended = await endVoiceSession(db, {
						id: session.id,
						reason: 'vendor_error',
						vendorErrorCode: msg.code,
					})
					if (ended) send({ type: 'ended', reason: 'vendor_error' })
					return
				}
				case 'turn_completed':
					await recordCounter(session.id, () =>
						recordVoiceTurn(db, session.id, {
							userAudioMs: msg.user_audio_ms,
							agentAudioMs: msg.agent_audio_ms,
						}),
					)
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
