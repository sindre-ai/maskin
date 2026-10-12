import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { LiveFunctionTool, ToolRisk } from '@maskin/mcp'
import {
	LIVE_AUDIO_KIND_USER,
	LIVE_PROTOCOL_VERSION,
	type LiveClientFrame,
	type LiveEndReason,
	type LiveErrorCode,
	type LiveUsage,
	decodeLiveAudioFrame,
	liveClientFrameSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { trackLiveToolCall, trackLiveTurnCompleted } from '../lib/analytics/live-events'
import { computeTtsCostUsd } from '../lib/live-costs'
import type { LiveCredentials } from '../lib/live-credentials'
import { PlanCapExceededError } from '../lib/llm-routing'
import {
	type ChatStreamEvent,
	type StreamChatParams,
	type StreamMessage,
	type StreamToolDefinition,
	streamChatCompletion,
} from '../lib/llm/openai-stream'
import { logger } from '../lib/logger'
import { getModelPricing } from '../lib/openrouter-pricing'
import { createSentenceChunker } from '../lib/sentence-chunker'
import { captureLiveException } from '../lib/sentry-live'
import { toLiveSpeech } from '../lib/speakable-text'
import { insertConversationMessage } from './conversation-messages'
import { createAudioPipeline } from './live-audio-pipeline'
import { type PulledUpObject, buildLiveContext } from './live-prompt'
import {
	type LiveSessionRow,
	activateLiveSession,
	endLiveSession,
	recordLiveTurn,
} from './live-session-lifecycle'
import { ensureLiveConversation, isLiveTranscriptEnabled, writeLiveLine } from './live-transcript'
import { synthesizeSentence } from './live-tts'
import type { TtsAudio } from './live-tts'
import {
	type LiveTurnDeps,
	type LocalTool,
	type PendingConfirmation,
	type TurnResult,
	runLiveTurn,
} from './live-turn-runner'

/**
 * One live call's server side. Owns turn state; the route owns the socket.
 * Everything that touches the outside world is injected, so a test can drive
 * the whole channel with a fake model, fake TTS and an in-memory socket.
 */

const OBJECT_EXCERPT_CHARS = 600
const MAX_PULLED_UP = 3

export interface LiveChannelIO {
	sendJson(frame: Record<string, unknown>): void
	sendBinary(data: Uint8Array): void
	/** Resolves when the socket can take more bytes; rejects if it stalls. */
	waitForDrain(): Promise<void>
	close(): void
}

export interface LiveChannelDeps {
	db: Database
	storage: StorageProvider
	session: LiveSessionRow
	agent: { id: string; name: string; systemPrompt: string | null }
	human: { id: string; name: string }
	creds: LiveCredentials
	io: LiveChannelIO
	opening?: 'briefing'
	tools: LiveFunctionTool[]
	invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>
	parseArgs(name: string, raw: unknown): Record<string, unknown>
	riskOf(name: string, args: unknown): ToolRisk
	label(name: string): string
	/** Throws PlanCapExceededError when the workspace is over its cap. */
	checkPlanCap(): Promise<void>
	// Overridable for tests.
	stream?: (p: StreamChatParams) => AsyncGenerator<ChatStreamEvent>
	synthesize?: (text: string, signal: AbortSignal) => Promise<TtsAudio>
	now?: () => number
	/** Leaves the agent's notes in the chat after a call. Best effort; runs after `ended` is sent. */
	closingNotes?: (session: LiveSessionRow) => Promise<unknown>
}

export interface LiveChannel {
	onOpen(): Promise<void>
	onMessage(data: string | ArrayBuffer | Uint8Array): Promise<void>
	/** The socket went away. The in-flight turn is aborted and persisted as interrupted. */
	onClose(): Promise<void>
	/** True once the call has ended on the server side. */
	readonly ended: boolean
}

interface ActiveTurn {
	turnIndex: number
	controller: AbortController
	done: Promise<void>
	playedSeq?: number
}

function nowIso(ms: number): string {
	return new Date(ms).toISOString()
}

/** A one-line description of a held action for the confirmation prompt. Never contains ids. */
export function summarizeToolCall(label: string, args: Record<string, unknown>): string {
	const title = typeof args.title === 'string' ? args.title : undefined
	const nodes = Array.isArray(args.nodes) ? args.nodes.length : undefined
	const ids = Array.isArray(args.ids) ? args.ids.length : undefined
	const detail = title
		? `: ${title}`
		: nodes
			? ` (${nodes} item${nodes === 1 ? '' : 's'})`
			: ids
				? ` (${ids} items)`
				: ''
	return `${label}${detail}`
}

export function createLiveChannel(deps: LiveChannelDeps): LiveChannel {
	const { db, session, agent, human, creds, io } = deps
	const now = deps.now ?? Date.now
	const stream = deps.stream ?? streamChatCompletion
	let speak = true
	let helloSeen = false
	// A reconnect builds a new channel; keep turn numbers moving forward from what the row recorded.
	let nextTurn = session.turnCount
	let active: ActiveTurn | null = null
	let pending: PendingConfirmation | null = null
	let pseudoSpent = false
	let pulledUp: PulledUpObject[] = []
	let endedFlag = false
	let conversationId: string | null = session.conversationId
	const inputMode = session.inputMode === 'text' ? 'text' : 'audio'

	const synthesize =
		deps.synthesize ??
		((text: string, signal: AbortSignal) =>
			synthesizeSentence({
				apiKey: creds.apiKey,
				baseUrl: creds.baseUrl,
				model: creds.ttsModel,
				voice: creds.ttsVoice,
				text,
				signal,
			}))

	const sendError = (code: LiveErrorCode, message: string, turnIndex?: number) =>
		io.sendJson({
			type: 'error',
			code,
			message,
			...(turnIndex !== undefined && { turn_index: turnIndex }),
		})

	async function lookupObject(id: string): Promise<PulledUpObject | null> {
		const [row] = await db
			.select({
				id: objects.id,
				type: objects.type,
				title: objects.title,
				status: objects.status,
				content: objects.content,
			})
			.from(objects)
			.where(and(eq(objects.id, id), eq(objects.workspaceId, session.workspaceId)))
			.limit(1)
		if (!row) return null
		return {
			id: row.id,
			type: row.type,
			title: row.title ?? 'Untitled',
			status: row.status,
			excerpt: (row.content ?? '').replace(/\s+/g, ' ').trim().slice(0, OBJECT_EXCERPT_CHARS),
		}
	}

	function addPulledUp(o: PulledUpObject) {
		pulledUp = [o, ...pulledUp.filter((p) => p.id !== o.id)].slice(0, MAX_PULLED_UP)
	}

	// ── Tools that exist only inside a live call ────────────────────────────

	function localTools(turnIndex: number): Record<string, LocalTool> {
		const tools: Record<string, LocalTool> = {
			pull_up_object: {
				label: deps.label('pull_up_object'),
				definition: {
					type: 'function',
					function: {
						name: 'pull_up_object',
						description:
							"Show an item on the person's screen while you talk about it. Use it when you are discussing a specific bet, task or insight so they can see it.",
						parameters: {
							type: 'object',
							properties: {
								object_id: { type: 'string', description: 'The id of the item to show.' },
							},
							required: ['object_id'],
						},
					},
				},
				async run(args) {
					const id = typeof args.object_id === 'string' ? args.object_id : ''
					const o = await lookupObject(id)
					if (!o)
						return { error: 'not_found', message: 'That item does not exist in this workspace.' }
					addPulledUp(o)
					io.sendJson({
						type: 'object.pulled_up',
						turn_index: turnIndex,
						object_id: o.id,
						object_type: o.type,
						title: o.title,
						status: o.status,
					})
					return { shown: o.title }
				},
			},
		}
		if (pending && pending.expiresAt > now()) {
			tools.confirm_pending_action = {
				label: deps.label('confirm_pending_action'),
				definition: {
					type: 'function',
					function: {
						name: 'confirm_pending_action',
						description: `The person was asked to confirm: "${pending.summary}". Call this with approved true if they said yes, approved false if they said no or changed their mind. Only call it after they have answered.`,
						parameters: {
							type: 'object',
							properties: { approved: { type: 'boolean' } },
							required: ['approved'],
						},
					},
				},
				async run(args) {
					const held = pending
					if (!held || held.expiresAt <= now()) {
						pending = null
						return { error: 'nothing_pending', message: 'There is nothing waiting for a yes.' }
					}
					pending = null
					if (args.approved !== true) return { status: 'declined', message: 'Nothing was done.' }
					const out = await deps.invokeTool(held.name, held.args)
					return { status: 'done', result: out }
				},
			}
		}
		return tools
	}

	// ── One turn ────────────────────────────────────────────────────────────

	async function estimateLlmCost(r: TurnResult): Promise<number> {
		if (r.usage.costUsd !== undefined) return r.usage.costUsd
		if (r.usage.promptTokens + r.usage.completionTokens === 0) return 0
		try {
			const p = await getModelPricing(creds.llmModel)
			if (!p) return 0
			return r.usage.promptTokens * p.prompt + r.usage.completionTokens * p.completion
		} catch {
			return 0
		}
	}

	async function startTurn(userText: string, opts: { persistUserLine: boolean }): Promise<void> {
		const turnIndex = nextTurn++
		const controller = new AbortController()
		const turn: ActiveTurn = { turnIndex, controller, done: Promise.resolve() }
		active = turn
		turn.done = executeTurn(turn, userText, opts).finally(() => {
			if (active === turn) active = null
		})
		await Promise.resolve()
	}

	async function executeTurn(
		turn: ActiveTurn,
		userText: string,
		opts: { persistUserLine: boolean },
	): Promise<void> {
		const { turnIndex, controller } = turn
		const startedAt = now()
		let firstDeltaAt: number | null = null
		let firstAudioAt: number | null = null
		const sentenceLastSeq = new Map<number, number>()
		const sentenceText: string[] = []
		let sentenceCount = 0
		const chunker = createSentenceChunker()

		io.sendJson({ type: 'turn.started', turn_index: turnIndex, client_turn_id: null })

		try {
			await deps.checkPlanCap()
		} catch (err) {
			if (err instanceof PlanCapExceededError) {
				sendError(
					'plan_cap_exceeded',
					'This workspace has used its included usage for now.',
					turnIndex,
				)
				await endCall('plan_cap', { fromTurn: true })
				return
			}
			throw err
		}

		const pipeline = speak
			? createAudioPipeline({
					turnIndex,
					io,
					synthesize,
					signal: controller.signal,
					onFirstAudio: () => {
						firstAudioAt = now()
					},
					onSentenceEnd: (i, last) => sentenceLastSeq.set(i, last),
					onSentenceError: (err, i) => {
						logger.warn('live tts sentence failed', {
							live_session_id: session.id,
							sentence_index: i,
							error: err instanceof Error ? err.message : String(err),
						})
						sendError('tts_failed', 'I could not speak that part.', turnIndex)
					},
				})
			: null

		const emitSentences = (sentences: string[]) => {
			for (const raw of sentences) {
				const text = toLiveSpeech(raw)
				if (!text) continue
				const i = sentenceCount++
				sentenceText[i] = text
				io.sendJson({ type: 'assistant.sentence', turn_index: turnIndex, sentence_index: i, text })
				pipeline?.enqueue(i, text)
			}
		}

		let result: TurnResult | null = null
		let toolCallCount = 0
		try {
			const ctx = await buildLiveContext({
				db,
				storage: deps.storage,
				workspaceId: session.workspaceId,
				agent,
				human,
				conversationId,
				pulledUp,
			})
			pulledUp = []

			// The user's line is written alongside the model call, not before it.
			const userLine =
				opts.persistUserLine && userText.trim()
					? writeLiveLine(db, {
							session,
							agentName: agent.name,
							role: 'user',
							text: userText,
							turnIndex,
							inputMode,
						}).catch((err) => {
							captureLiveException(session.id, err)
							return null
						})
					: Promise.resolve(null)
			void userLine.then((w) => {
				if (w) conversationId = w.conversationId
			})
			// Sent now, before any assistant frame, so the order is the same every turn. The stored
			// message arrives for the client through the conversation's own events.
			if (opts.persistUserLine) {
				io.sendJson({
					type: 'transcript.user',
					turn_index: turnIndex,
					text: userText,
					message_id: null,
				})
			}

			const turnDeps: LiveTurnDeps = {
				stream: (p) =>
					stream({
						apiKey: creds.apiKey,
						baseUrl: creds.baseUrl,
						model: creds.llmModel,
						messages: p.messages as StreamMessage[],
						tools: p.tools as StreamToolDefinition[] | undefined,
						signal: p.signal,
						...(creds.providerPrefs && { extraBody: { provider: creds.providerPrefs } }),
					}),
				invokeTool: deps.invokeTool,
				parseArgs: deps.parseArgs,
				riskOf: deps.riskOf,
				label: deps.label,
				summarize: (name, args) => summarizeToolCall(deps.label(name), args),
				tools: deps.tools,
				localTools: localTools(turnIndex),
				now,
			}

			result = await runLiveTurn({
				deps: turnDeps,
				system: ctx.system,
				history: ctx.history,
				userText,
				signal: controller.signal,
				pendingConfirmation: pending,
				pseudoCorrectionSpent: pseudoSpent,
				sinks: {
					onDelta: (text) => {
						if (firstDeltaAt === null) firstDeltaAt = now()
						io.sendJson({ type: 'assistant.delta', turn_index: turnIndex, text })
						emitSentences(chunker.push(text))
					},
					onRetract: () => {
						chunker.flush() // drop the buffered, not-yet-spoken remainder
					},
					onToolStarted: (callId, label) => {
						toolCallCount++
						io.sendJson({ type: 'tool.started', turn_index: turnIndex, call_id: callId, label })
					},
					onToolFinished: (callId, label, ok) => {
						io.sendJson({
							type: 'tool.finished',
							turn_index: turnIndex,
							call_id: callId,
							label,
							ok,
						})
					},
					onConfirmRequired: (p) => {
						io.sendJson({
							type: 'tool.confirm_required',
							turn_index: turnIndex,
							confirmation_id: p.id,
							label: p.label,
							summary: p.summary,
							expires_at: nowIso(p.expiresAt),
						})
					},
				},
			})
			pending = result.pendingConfirmation
			if (result.correctedPseudoToolCall) pseudoSpent = true
			if (!result.interrupted) emitSentences(chunker.flush())
		} catch (err) {
			captureLiveException(session.id, err)
			logger.error('live turn failed', {
				live_session_id: session.id,
				turn_index: turnIndex,
				error: err instanceof Error ? err.message : String(err),
			})
			sendError('llm_failed', 'I could not get an answer just now. Try again.', turnIndex)
		}

		// Finish the audio. On interrupt the controller is aborted so the pipeline stops sending.
		const audio = pipeline ? await pipeline.finish().catch(() => null) : null

		const interrupted = controller.signal.aborted
		const fullText = result?.text ?? ''
		let content = fullText
		if (interrupted && speak) {
			const heard = turn.playedSeq
			const parts: string[] = []
			for (let i = 0; i < sentenceText.length; i++) {
				const last = sentenceLastSeq.get(i)
				if (last !== undefined && (heard === undefined || last <= heard))
					parts.push(sentenceText[i] ?? '')
				else break
			}
			content = parts.join(' ')
		}

		const llmCost = result ? await estimateLlmCost(result) : 0
		const ttsChars = audio?.characters ?? 0
		const usage: LiveUsage = {
			input_tokens: result?.usage.promptTokens ?? 0,
			output_tokens: result?.usage.completionTokens ?? 0,
			llm_cost_usd: llmCost,
			tts_characters: ttsChars,
			tts_cost_usd: computeTtsCostUsd(ttsChars),
			stt_seconds: 0,
		}

		let messageId: number | null = null
		try {
			const w = await writeLiveLine(db, {
				session,
				agentName: agent.name,
				role: 'assistant',
				text: content,
				turnIndex,
				inputMode,
				fullText,
				interrupted,
				toolCalls: result?.toolCalls.map(({ name, label, ok }) => ({ name, label, ok })),
			})
			messageId = w?.messageId ?? null
			if (w) conversationId = w.conversationId
		} catch (err) {
			captureLiveException(session.id, err)
		}

		await recordLiveTurn(db, session.id, {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			ttsCharacters: usage.tts_characters,
			sttSeconds: 0,
			llmCostUsd: usage.llm_cost_usd,
			ttsCostUsd: usage.tts_cost_usd,
			sttCostUsd: 0,
			toolCalls: toolCallCount,
		}).catch((err) => captureLiveException(session.id, err))

		io.sendJson({
			type: 'turn.finished',
			turn_index: turnIndex,
			message_id: messageId,
			interrupted,
			usage,
			duration_ms: now() - startedAt,
		})

		for (const t of result?.toolCalls ?? []) {
			void trackLiveToolCall(human.id, {
				live_session_id: session.id,
				tool_name: t.name,
				success: t.ok,
				latency_ms: t.ms,
			})
		}
		void trackLiveTurnCompleted(human.id, {
			live_session_id: session.id,
			turn_index: turnIndex,
			input_mode: inputMode,
			ttft_ms: firstDeltaAt === null ? null : firstDeltaAt - startedAt,
			ttfa_ms: firstAudioAt === null ? null : firstAudioAt - startedAt,
			tool_calls: toolCallCount,
			interrupted,
			llm_cost_usd: usage.llm_cost_usd,
			tts_characters: usage.tts_characters,
			model: creds.llmModel,
		})
	}

	// ── Ending ──────────────────────────────────────────────────────────────

	async function endCall(reason: LiveEndReason, opts: { fromTurn?: boolean } = {}): Promise<void> {
		if (endedFlag) return
		endedFlag = true
		active?.controller.abort()
		// Called from inside the turn itself (plan cap): waiting on it would wait on ourselves.
		if (!opts.fromTurn) await active?.done.catch(() => {})
		const row = await endLiveSession(db, { id: session.id, reason }).catch((err) => {
			captureLiveException(session.id, err)
			return null
		})
		const finishedRow = row
		io.sendJson({ type: 'ended', reason })
		io.close()
		// After the client has its `ended`: the system line, then the agent's notes.
		if (finishedRow && conversationId) {
			const seconds = Math.max(
				0,
				Math.round(
					((finishedRow.endedAt ?? new Date()).getTime() - finishedRow.startedAt.getTime()) / 1000,
				),
			)
			void (async () => {
				await writeEndedLine(seconds)
				await deps.closingNotes?.({ ...finishedRow, conversationId })
			})().catch((err) => captureLiveException(session.id, err))
		}
	}

	async function writeEndedLine(seconds: number): Promise<void> {
		try {
			if (!conversationId || !(await isLiveTranscriptEnabled(db, session.workspaceId))) return
			const m = Math.floor(seconds / 60)
			const s = String(seconds % 60).padStart(2, '0')
			await insertConversationMessage(db, {
				conversationId,
				workspaceId: session.workspaceId,
				actorId: human.id,
				content: `Live with ${agent.name} · ${m}:${s}`,
				metadata: { source: 'live', live_session_id: session.id },
				sessionId: null,
				kind: 'system',
			})
		} catch (err) {
			captureLiveException(session.id, err)
		}
	}

	// ── Frames ──────────────────────────────────────────────────────────────

	async function interruptActive(playedSeq?: number): Promise<void> {
		const turn = active
		if (!turn) return
		if (playedSeq !== undefined) turn.playedSeq = playedSeq
		turn.controller.abort()
		await turn.done.catch(() => {})
	}

	async function handleFrame(frame: LiveClientFrame): Promise<void> {
		switch (frame.type) {
			case 'hello': {
				if (frame.protocol_version !== LIVE_PROTOCOL_VERSION) {
					sendError('unsupported_protocol', `Protocol ${frame.protocol_version} is not supported.`)
					io.close()
					return
				}
				helloSeen = true
				speak = frame.speak
				return
			}
			case 'ping':
				io.sendJson({ type: 'pong' })
				return
			case 'turn.text': {
				if (!helloSeen) helloSeen = true
				if (active) {
					if (!frame.interrupt) {
						sendError('turn_in_progress', 'A reply is still in progress.')
						return
					}
					await interruptActive()
				}
				await startTurn(frame.text, { persistUserLine: true })
				return
			}
			case 'interrupt': {
				// Abort and return: the turn finishes itself (persisting what was heard), and other
				// frames must not queue behind it.
				if (active && active.turnIndex === frame.turn_index) {
					if (frame.played_seq !== undefined) active.playedSeq = frame.played_seq
					active.controller.abort()
				}
				return
			}
			case 'context.object': {
				const o = await lookupObject(frame.object_id)
				if (o) addPulledUp(o)
				return
			}
			case 'confirm': {
				const held = pending
				if (!held || held.id !== frame.confirmation_id || held.expiresAt <= now()) {
					sendError('invalid_message', 'That confirmation is no longer open.')
					return
				}
				if (active) await interruptActive()
				pending = null
				if (!frame.approved) {
					await startTurn(
						`(The person tapped to decline "${held.summary}". Nothing was done. Acknowledge in a few words.)`,
						{ persistUserLine: false },
					)
					return
				}
				let outcome: string
				try {
					const out = await deps.invokeTool(held.name, held.args)
					outcome = `It has been done. Result: ${JSON.stringify(out).slice(0, 2000)}`
				} catch (err) {
					outcome = `It failed: ${err instanceof Error ? err.message : 'unknown error'}`
				}
				await startTurn(
					`(The person tapped to approve "${held.summary}". ${outcome} Tell them briefly.)`,
					{ persistUserLine: false },
				)
				return
			}
			case 'turn.audio.start':
			case 'turn.audio.end':
				sendError(
					'stt_failed',
					'Spoken input to the server is not enabled. Send the recognised text instead.',
				)
				return
			case 'end':
				await endCall(frame.reason ?? 'user_hangup')
				return
		}
	}

	return {
		get ended() {
			return endedFlag
		},

		async onOpen() {
			await activateLiveSession(db, session.id)
			const persist = await isLiveTranscriptEnabled(db, session.workspaceId)
			if (persist && !conversationId) {
				try {
					conversationId = await ensureLiveConversation(db, session, agent.name)
				} catch (err) {
					captureLiveException(session.id, err)
				}
			}
			io.sendJson({
				type: 'ready',
				live_session_id: session.id,
				conversation_id: conversationId,
				agent: { id: agent.id, name: agent.name },
				llm_model: creds.llmModel,
				tts: { model: creds.ttsModel, voice: creds.ttsVoice },
				persist_transcripts: persist,
				...(session.turnCount > 0 && {
					resume: { turn_index: session.turnCount - 1, status: 'finished' },
				}),
			})
			if (deps.opening === 'briefing' && nextTurn === 0) {
				await startTurn(
					"Walk me through today's brief: what changed, what needs me, and what's next. Keep it spoken and short enough to interrupt.",
					{ persistUserLine: false },
				)
			}
		},

		async onMessage(data) {
			if (endedFlag) return
			if (typeof data !== 'string') {
				const bytes =
					data instanceof Uint8Array
						? data
						: data instanceof ArrayBuffer
							? new Uint8Array(data)
							: null
				const frame = bytes ? decodeLiveAudioFrame(bytes) : null
				if (frame?.header.kind === LIVE_AUDIO_KIND_USER) {
					sendError(
						'stt_failed',
						'Spoken input to the server is not enabled. Send the recognised text instead.',
					)
				}
				return
			}
			let parsed: unknown
			try {
				parsed = JSON.parse(data)
			} catch {
				sendError('invalid_message', 'Frames must be JSON.')
				return
			}
			const result = liveClientFrameSchema.safeParse(parsed)
			if (!result.success) {
				sendError('invalid_message', 'That frame was not understood.')
				return
			}
			await handleFrame(result.data)
		},

		async onClose() {
			if (endedFlag) return
			if (active) {
				active.controller.abort()
				await active.done.catch(() => {})
			}
		},
	}
}
