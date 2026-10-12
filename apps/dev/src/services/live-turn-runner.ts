import { randomUUID } from 'node:crypto'
import type { LiveFunctionTool, ToolRisk } from '@maskin/mcp'
import type { ChatStreamEvent, StreamMessage, StreamToolDefinition } from '../lib/llm/openai-stream'
import { ToolCallAccumulator } from '../lib/llm/openai-stream'
import { detectPseudoToolCalls } from '../lib/pseudo-tool-call'

/**
 * One live turn: stream the model, run its tool calls, feed the results back,
 * repeat until it answers in words. Pure of I/O beyond the injected `stream` and
 * `invokeTool`, so the whole loop is unit-testable with a fake model.
 */

export const MAX_TOOL_ROUNDS = 6
export const TOOL_TIMEOUT_MS = 20_000
export const TOOL_RESULT_MAX_CHARS = 8_000
export const CONFIRMATION_TTL_MS = 2 * 60_000

export interface PendingConfirmation {
	id: string
	name: string
	args: Record<string, unknown>
	label: string
	summary: string
	expiresAt: number
}

export interface LiveTurnSinks {
	onDelta(text: string): void
	/** Text already delivered to the sentence pipeline must be dropped (a corrupted reply is being retried). */
	onRetract(): void
	onToolStarted(callId: string, label: string): void
	onToolFinished(callId: string, label: string, ok: boolean): void
	onConfirmRequired(p: PendingConfirmation): void
}

/** A tool that exists only inside live mode and is run by the channel, not the MCP server. */
export interface LocalTool {
	definition: StreamToolDefinition
	label: string
	run(args: Record<string, unknown>): Promise<unknown>
}

export interface LiveTurnDeps {
	stream(params: {
		messages: StreamMessage[]
		tools?: StreamToolDefinition[]
		signal: AbortSignal
	}): AsyncGenerator<ChatStreamEvent>
	invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>
	/** Validates and normalises model-supplied args; throws with a message the model can act on. */
	parseArgs(name: string, raw: unknown): Record<string, unknown>
	riskOf(name: string, args: unknown): ToolRisk
	label(name: string): string
	/** One-line human summary of a pending action, e.g. "Delete the Q4 bet". */
	summarize(name: string, args: Record<string, unknown>): string
	tools: LiveFunctionTool[]
	localTools?: Record<string, LocalTool>
	now?: () => number
	toolTimeoutMs?: number
	maxRounds?: number
}

export interface TurnUsage {
	promptTokens: number
	completionTokens: number
	/** USD from OpenRouter; undefined when no round reported a cost. */
	costUsd?: number
}

export interface TurnResult {
	text: string
	toolCalls: Array<{ name: string; label: string; ok: boolean; ms: number }>
	usage: TurnUsage
	finish: 'stop' | 'length' | 'tool_rounds' | 'other'
	interrupted: boolean
	/** Set when a confirm-tier tool is waiting for a yes. Carried into the next turn. */
	pendingConfirmation: PendingConfirmation | null
	/** True when a pseudo-tool-call reply was detected and the model was asked again. */
	correctedPseudoToolCall: boolean
}

const PSEUDO_CORRECTION =
	'Your last reply described tool calls as text instead of making them. Do not write tool calls as text. Either call the tool for real, or answer in plain spoken sentences.'

function capResult(value: unknown): string {
	let s: string
	try {
		s = typeof value === 'string' ? value : JSON.stringify(value)
	} catch {
		s = String(value)
	}
	if (s === undefined) s = 'null'
	return s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]` : s
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s.`)),
			ms,
		)
		const onAbort = () => {
			clearTimeout(timer)
			reject(new DOMException('Aborted', 'AbortError'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
		p.then(
			(v) => {
				clearTimeout(timer)
				signal.removeEventListener('abort', onAbort)
				resolve(v)
			},
			(e) => {
				clearTimeout(timer)
				signal.removeEventListener('abort', onAbort)
				reject(e)
			},
		)
	})
}

function isAbort(e: unknown): boolean {
	return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

function toStreamTool(t: LiveFunctionTool): StreamToolDefinition {
	return { type: 'function', function: t.function }
}

export interface RunLiveTurnParams {
	deps: LiveTurnDeps
	system: string
	history: StreamMessage[]
	userText: string
	signal: AbortSignal
	sinks: LiveTurnSinks
	pendingConfirmation: PendingConfirmation | null
	/** Whether a pseudo-tool-call correction was already spent this session. */
	pseudoCorrectionSpent: boolean
}

export async function runLiveTurn(p: RunLiveTurnParams): Promise<TurnResult> {
	const { deps, sinks, signal } = p
	const now = deps.now ?? Date.now
	const maxRounds = deps.maxRounds ?? MAX_TOOL_ROUNDS
	const toolTimeoutMs = deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS

	const messages: StreamMessage[] = [
		{ role: 'system', content: p.system },
		...p.history,
		{ role: 'user', content: p.userText },
	]
	const result: TurnResult = {
		text: '',
		toolCalls: [],
		usage: { promptTokens: 0, completionTokens: 0 },
		finish: 'other',
		interrupted: false,
		pendingConfirmation:
			p.pendingConfirmation && p.pendingConfirmation.expiresAt > now()
				? p.pendingConfirmation
				: null,
		correctedPseudoToolCall: false,
	}
	let pseudoSpent = p.pseudoCorrectionSpent
	const baseTools = deps.tools.map(toStreamTool)

	/** Runs one call and returns the string handed back to the model. */
	async function executeCall(
		callId: string,
		name: string,
		rawArgs: unknown,
		parseError?: string,
	): Promise<string> {
		const started = now()
		const record = (label: string, ok: boolean) =>
			result.toolCalls.push({ name, label, ok, ms: now() - started })

		const local = deps.localTools?.[name]
		const label = local?.label ?? deps.label(name)
		if (parseError) {
			record(label, false)
			return capResult({
				error: 'invalid_arguments',
				message: 'The arguments were not valid JSON.',
			})
		}

		let args: Record<string, unknown>
		try {
			args = local ? ((rawArgs ?? {}) as Record<string, unknown>) : deps.parseArgs(name, rawArgs)
		} catch (e) {
			record(label, false)
			return capResult({
				error: 'invalid_arguments',
				message: e instanceof Error ? e.message : 'Invalid arguments.',
			})
		}

		if (local) {
			sinks.onToolStarted(callId, label)
			try {
				const out = await withTimeout(local.run(args), toolTimeoutMs, signal)
				sinks.onToolFinished(callId, label, true)
				record(label, true)
				return capResult(out)
			} catch (e) {
				if (isAbort(e) && signal.aborted) throw e
				sinks.onToolFinished(callId, label, false)
				record(label, false)
				return capResult({
					error: 'tool_failed',
					message: e instanceof Error ? e.message : 'Failed.',
				})
			}
		}

		const risk = deps.riskOf(name, args)
		if (risk === 'excluded') {
			record(label, false)
			return capResult({
				error: 'not_available',
				message: 'That is not available on a live call. Offer to do it in text chat.',
			})
		}
		if (risk === 'confirm') {
			const pending: PendingConfirmation = {
				id: randomUUID(),
				name,
				args,
				label,
				summary: deps.summarize(name, args),
				expiresAt: now() + CONFIRMATION_TTL_MS,
			}
			result.pendingConfirmation = pending
			sinks.onConfirmRequired(pending)
			record(label, true)
			return capResult({
				status: 'confirmation_required',
				action: pending.summary,
				instruction:
					'Nothing has been done yet. Ask the person one short yes or no question about this action, then stop and wait for their answer. If they say yes, call confirm_pending_action with approved true; if no, with approved false.',
			})
		}

		sinks.onToolStarted(callId, label)
		try {
			const out = await withTimeout(deps.invokeTool(name, args), toolTimeoutMs, signal)
			sinks.onToolFinished(callId, label, true)
			record(label, true)
			return capResult(out)
		} catch (e) {
			if (isAbort(e) && signal.aborted) throw e
			sinks.onToolFinished(callId, label, false)
			record(label, false)
			return capResult({
				error: 'tool_failed',
				message: e instanceof Error ? e.message : 'Failed.',
			})
		}
	}

	// Text of the round in flight, so an interrupt can keep what was already said.
	let inFlightText = ''
	try {
		for (let round = 0; round < maxRounds; round++) {
			const lastRound = round === maxRounds - 1
			// The final round offers no tools at all, which forces a spoken answer
			// rather than another lookup.
			const toolsForRound = lastRound
				? undefined
				: [...baseTools, ...Object.values(deps.localTools ?? {}).map((t) => t.definition)]

			const acc = new ToolCallAccumulator()
			let roundText = ''
			inFlightText = ''
			let finish: 'stop' | 'tool_calls' | 'length' | 'other' = 'other'
			let retried = false

			const ctrl = new AbortController()
			const onOuterAbort = () => ctrl.abort(signal.reason)
			if (signal.aborted) ctrl.abort(signal.reason)
			else signal.addEventListener('abort', onOuterAbort, { once: true })

			try {
				for await (const ev of deps.stream({
					messages,
					tools: toolsForRound,
					signal: ctrl.signal,
				})) {
					if (ev.type === 'text') {
						roundText += ev.delta
						inFlightText = roundText
						if (ev.delta.includes('<') || ev.delta.includes('>')) {
							const verdict = detectPseudoToolCalls(roundText)
							if (verdict.detected && !pseudoSpent) {
								retried = true
								ctrl.abort()
								break
							}
						}
						sinks.onDelta(ev.delta)
					} else if (ev.type === 'tool_call') {
						acc.push(ev)
					} else if (ev.type === 'usage') {
						result.usage.promptTokens += ev.usage.prompt_tokens
						result.usage.completionTokens += ev.usage.completion_tokens
						if (ev.usage.cost !== undefined) {
							result.usage.costUsd = (result.usage.costUsd ?? 0) + ev.usage.cost
						}
					} else if (ev.type === 'finish') {
						finish = ev.reason
					}
				}
			} catch (e) {
				if (!(retried && isAbort(e))) throw e
			} finally {
				signal.removeEventListener('abort', onOuterAbort)
			}

			if (retried) {
				pseudoSpent = true
				result.correctedPseudoToolCall = true
				sinks.onRetract()
				messages.push({ role: 'assistant', content: roundText })
				messages.push({ role: 'user', content: PSEUDO_CORRECTION })
				round-- // the correction is not a tool round
				continue
			}

			if (roundText) {
				const sep = result.text && !/\s$/.test(result.text) ? ' ' : ''
				result.text += sep + roundText
			}
			inFlightText = ''

			const calls = acc.finish()
			if (calls.length === 0) {
				result.finish = finish === 'length' ? 'length' : finish === 'stop' ? 'stop' : 'other'
				return result
			}

			messages.push({
				role: 'assistant',
				content: roundText || null,
				tool_calls: calls.map((c) => ({
					id: c.id,
					type: 'function' as const,
					function: { name: c.name, arguments: JSON.stringify(c.arguments) },
				})),
			})
			const outputs = await Promise.all(
				calls.map(async (c) => ({
					id: c.id,
					content: await executeCall(c.id, c.name, c.arguments, c.parseError),
				})),
			)
			for (const o of outputs)
				messages.push({ role: 'tool', tool_call_id: o.id, content: o.content })
			if (lastRound) break
		}
		result.finish = 'tool_rounds'
		return result
	} catch (e) {
		if (isAbort(e) || signal.aborted) {
			if (inFlightText) {
				const sep = result.text && !/\s$/.test(result.text) ? ' ' : ''
				result.text += sep + inFlightText
			}
			result.interrupted = true
			result.finish = 'other'
			return result
		}
		throw e
	}
}
