import { logger } from '../logger'
import { parseSseStream } from '../sse-parser'
import { LlmNoEligibleHostError } from './adapter'

/**
 * Streaming chat completions against an OpenAI-compatible endpoint (OpenRouter).
 *
 * This is a function rather than a method on OpenAIAdapter: the adapter's
 * message type has no room for an assistant message's `tool_calls`, which a
 * tool loop must replay, and widening it would touch every existing caller.
 */

export interface StreamToolDefinition {
	type: 'function'
	function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type StreamMessage =
	| { role: 'system' | 'user'; content: string }
	| {
			role: 'assistant'
			content: string | null
			tool_calls?: Array<{
				id: string
				type: 'function'
				function: { name: string; arguments: string }
			}>
	  }
	| { role: 'tool'; tool_call_id: string; content: string }

export interface StreamedUsage {
	prompt_tokens: number
	completion_tokens: number
	/** USD, reported by OpenRouter when `usage: {include: true}` is sent. */
	cost?: number
}

export type ChatStreamEvent =
	| { type: 'text'; delta: string }
	| { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta: string }
	| { type: 'usage'; usage: StreamedUsage }
	| { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'other' }

export interface StreamChatParams {
	apiKey: string
	baseUrl: string
	model: string
	messages: StreamMessage[]
	tools?: StreamToolDefinition[]
	temperature?: number
	maxTokens?: number
	/** Merged into the request body, e.g. OpenRouter `provider` preferences. */
	extraBody?: Record<string, unknown>
	signal?: AbortSignal
	fetchImpl?: typeof fetch
}

export class LlmStreamError extends Error {
	readonly status?: number
	constructor(message: string, status?: number) {
		super(message)
		this.name = 'LlmStreamError'
		this.status = status
	}
}

function toFinishReason(raw: unknown): 'stop' | 'tool_calls' | 'length' | 'other' {
	if (raw === 'stop') return 'stop'
	if (raw === 'tool_calls') return 'tool_calls'
	if (raw === 'length') return 'length'
	return 'other'
}

export async function* streamChatCompletion(p: StreamChatParams): AsyncGenerator<ChatStreamEvent> {
	const body: Record<string, unknown> = {
		...p.extraBody,
		model: p.model,
		messages: p.messages,
		stream: true,
		// Ask OpenRouter to report token counts and cost on the final chunk.
		usage: { include: true },
	}
	if (p.tools?.length) body.tools = p.tools
	if (p.temperature !== undefined) body.temperature = p.temperature
	if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens

	const res = await (p.fetchImpl ?? fetch)(`${p.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			Authorization: `Bearer ${p.apiKey}`,
		},
		body: JSON.stringify(body),
		signal: p.signal,
	})

	if (!res.ok) {
		const text = await res.text().catch(() => '')
		if (p.extraBody?.provider && res.status === 404 && /no endpoints found/i.test(text)) {
			logger.error('live_zdr_no_eligible_host', { model: p.model, status: res.status })
			throw new LlmNoEligibleHostError(
				`No OpenRouter host satisfies the provider preferences for ${p.model}. Unset MASKIN_FALLBACK_ZDR to stop sending them.`,
			)
		}
		throw new LlmStreamError(
			`OpenRouter chat error: ${res.status} ${text.slice(0, 500)}`,
			res.status,
		)
	}
	if (!res.body) throw new LlmStreamError('OpenRouter returned no response body', res.status)

	let finished = false
	for await (const ev of parseSseStream(res.body, p.signal)) {
		if (ev.data === '[DONE]') break
		let chunk: Record<string, unknown>
		try {
			chunk = JSON.parse(ev.data) as Record<string, unknown>
		} catch {
			continue // a malformed keepalive is not worth failing a call over
		}
		// Mid-stream provider failure: OpenRouter sends an `error` object in a chunk.
		if (chunk.error && typeof chunk.error === 'object') {
			const err = chunk.error as { message?: unknown; code?: unknown }
			throw new LlmStreamError(
				`OpenRouter stream error: ${typeof err.message === 'string' ? err.message : 'unknown'}`,
				typeof err.code === 'number' ? err.code : undefined,
			)
		}
		const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
		if (choice) {
			const delta = (choice.delta ?? {}) as Record<string, unknown>
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				yield { type: 'text', delta: delta.content }
			}
			const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
			for (const tc of toolCalls ?? []) {
				const fn = (tc.function ?? {}) as Record<string, unknown>
				yield {
					type: 'tool_call',
					index: typeof tc.index === 'number' ? tc.index : 0,
					...(typeof tc.id === 'string' && { id: tc.id }),
					...(typeof fn.name === 'string' && { name: fn.name }),
					argumentsDelta: typeof fn.arguments === 'string' ? fn.arguments : '',
				}
			}
			if (choice.finish_reason != null && !finished) {
				finished = true
				yield { type: 'finish', reason: toFinishReason(choice.finish_reason) }
			}
		}
		const usage = chunk.usage as Record<string, unknown> | undefined
		if (usage && typeof usage.prompt_tokens === 'number') {
			yield {
				type: 'usage',
				usage: {
					prompt_tokens: usage.prompt_tokens,
					completion_tokens:
						typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
					...(typeof usage.cost === 'number' && { cost: usage.cost }),
				},
			}
		}
	}
	if (!finished) yield { type: 'finish', reason: 'other' }
}

/** Collects streamed tool-call fragments (keyed by index) into complete calls. */
export class ToolCallAccumulator {
	private calls = new Map<number, { id: string; name: string; args: string }>()

	push(ev: Extract<ChatStreamEvent, { type: 'tool_call' }>): void {
		const cur = this.calls.get(ev.index) ?? { id: '', name: '', args: '' }
		if (ev.id) cur.id = ev.id
		if (ev.name) cur.name = ev.name
		cur.args += ev.argumentsDelta
		this.calls.set(ev.index, cur)
	}

	get size(): number {
		return this.calls.size
	}

	/** Complete calls in index order. Unparseable arguments are returned as `parseError`. */
	finish(): Array<{ id: string; name: string; arguments: unknown; parseError?: string }> {
		return [...this.calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([index, c]) => {
				const id = c.id || `call_${index}`
				if (c.args.trim() === '') return { id, name: c.name, arguments: {} }
				try {
					return { id, name: c.name, arguments: JSON.parse(c.args) as unknown }
				} catch (e) {
					return {
						id,
						name: c.name,
						arguments: {},
						parseError: e instanceof Error ? e.message : 'invalid JSON',
					}
				}
			})
	}
}
