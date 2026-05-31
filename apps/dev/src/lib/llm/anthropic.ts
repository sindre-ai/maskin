import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './adapter'

export interface AnthropicStreamChunk {
	type: 'text' | 'usage' | 'done'
	text?: string
	inputTokens?: number
	outputTokens?: number
}

export class AnthropicAdapter implements LLMAdapter {
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey = apiKey
	}

	async chat(options: {
		model: string
		messages: LLMMessage[]
		tools?: LLMTool[]
		temperature?: number
	}): Promise<LLMResponse> {
		const systemMessage = options.messages.find((m) => m.role === 'system')
		const otherMessages = options.messages.filter((m) => m.role !== 'system')

		const body: Record<string, unknown> = {
			model: options.model || 'claude-opus-4-7',
			max_tokens: 4096,
			messages: otherMessages.map((m) => {
				if (m.role === 'tool') {
					return {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: m.tool_call_id,
								content: m.content,
							},
						],
					}
				}
				return { role: m.role, content: m.content }
			}),
		}

		if (systemMessage) {
			body.system = systemMessage.content
		}

		if (options.tools?.length) {
			body.tools = options.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}))
		}

		if (options.temperature !== undefined) {
			body.temperature = options.temperature
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`Anthropic API error: ${response.status} ${error}`)
		}

		const data = (await response.json()) as Record<string, unknown>
		const contentBlocks = (data.content ?? []) as Array<Record<string, unknown>>

		const toolCalls = contentBlocks
			.filter((block) => block.type === 'tool_use')
			.map((block) => ({
				id: block.id as string,
				name: block.name as string,
				arguments: block.input as Record<string, unknown>,
			}))

		const textContent = contentBlocks
			.filter((block) => block.type === 'text')
			.map((block) => block.text as string)
			.join('')

		return {
			content: textContent || null,
			tool_calls: toolCalls,
			finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
		}
	}

	async *chatStream(options: {
		model: string
		system?: string
		userPrompt: string
		maxTokens?: number
		temperature?: number
		signal?: AbortSignal
	}): AsyncGenerator<AnthropicStreamChunk> {
		const { signal } = options
		const body = {
			model: options.model || 'claude-opus-4-7',
			max_tokens: options.maxTokens ?? 2048,
			temperature: options.temperature,
			system: options.system,
			messages: [{ role: 'user', content: options.userPrompt }],
			stream: true,
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok || !response.body) {
			const error = await response.text().catch(() => '<no body>')
			throw new Error(`Anthropic stream error: ${response.status} ${error}`)
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let inputTokens = 0
		let outputTokens = 0
		let aborted = false

		try {
			while (true) {
				if (signal?.aborted) {
					aborted = true
					break
				}
				let chunk: ReadableStreamReadResult<Uint8Array>
				try {
					chunk = await reader.read()
				} catch (err) {
					// `fetch` aborts surface as AbortError/DOMException with name='AbortError'.
					// Treat them as clean cancels rather than upstream failures.
					if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
						aborted = true
						break
					}
					throw err
				}
				if (chunk.done) break
				buffer += decoder.decode(chunk.value, { stream: true })
				const events = buffer.split('\n\n')
				buffer = events.pop() ?? ''
				for (const evt of events) {
					const dataLine = evt.split('\n').find((l) => l.startsWith('data:'))
					if (!dataLine) continue
					const payload = dataLine.slice(5).trim()
					if (!payload || payload === '[DONE]') continue
					let parsed: Record<string, unknown>
					try {
						parsed = JSON.parse(payload) as Record<string, unknown>
					} catch {
						continue
					}
					if (parsed.type === 'content_block_delta') {
						const delta = parsed.delta as { type?: string; text?: string } | undefined
						if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
							yield { type: 'text', text: delta.text }
						}
					} else if (parsed.type === 'message_start') {
						const usage = (parsed.message as { usage?: { input_tokens?: number } } | undefined)
							?.usage
						if (usage?.input_tokens) inputTokens = usage.input_tokens
					} else if (parsed.type === 'message_delta') {
						const usage = parsed.usage as { output_tokens?: number } | undefined
						if (usage?.output_tokens) outputTokens = usage.output_tokens
					}
				}
			}
		} finally {
			if (aborted) {
				try {
					await reader.cancel()
				} catch {}
			}
		}

		if (aborted) return

		yield { type: 'usage', inputTokens, outputTokens }
		yield { type: 'done' }
	}
}
