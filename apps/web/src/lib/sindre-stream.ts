/**
 * Parser for the Claude Code CLI `--output-format stream-json` log stream
 * that Sindre's interactive session emits on stdout. Each stdout log line is
 * one JSON envelope; this module turns each line into zero or more typed
 * transcript events that the UI can render directly.
 *
 * Line envelopes the CLI emits:
 *   - `{ type: 'system', subtype, session_id, ... }` — init / lifecycle
 *   - `{ type: 'assistant', message: { content: Block[], id }, session_id }`
 *     where each content block is `text`, `tool_use`, or `thinking`
 *   - `{ type: 'user', message: { content: [{ type: 'tool_result', ... }] } }`
 *     echoing the tool result back into the conversation (no event emitted —
 *     the UI already has the matching `tool_use`)
 *   - `{ type: 'result', subtype, is_error, result, duration_ms, ... }`
 *   - `{ type: 'error', message, ... }`
 *
 * Any line that isn't valid JSON, or doesn't match one of the envelopes
 * above, is surfaced as `{ kind: 'debug', raw }` so the UI can collapse it
 * behind a "debug" bucket without losing data.
 */

export type UserAttachmentView =
	| { kind: 'agent'; id: string; name: string | null }
	| { kind: 'object'; id: string; title: string | null; type: string | null }
	| { kind: 'notification'; id: string; title: string | null }
	| { kind: 'file'; name: string; sizeBytes: number }

export type SindreEvent =
	| { kind: 'user'; text: string; attachments?: UserAttachmentView[] }
	| { kind: 'text'; text: string; sessionId?: string; messageId?: string }
	| {
			kind: 'tool_use'
			id: string
			name: string
			input: unknown
			sessionId?: string
			messageId?: string
	  }
	| {
			kind: 'thinking'
			text: string
			redacted?: boolean
			sessionId?: string
			messageId?: string
	  }
	| {
			kind: 'result'
			subtype: string
			isError: boolean
			text?: string
			durationMs?: number
			numTurns?: number
			totalCostUsd?: number
			sessionId?: string
	  }
	| { kind: 'system'; subtype: string; sessionId?: string; data: Record<string, unknown> }
	| { kind: 'error'; message: string; data: Record<string, unknown> }
	| { kind: 'debug'; raw: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseAssistant(envelope: Record<string, unknown>): SindreEvent[] | null {
	const message = envelope.message
	if (!isRecord(message)) return null
	const content = message.content
	if (!Array.isArray(content)) return null

	const sessionId = asString(envelope.session_id)
	const messageId = asString(message.id)
	const events: SindreEvent[] = []

	for (const block of content) {
		if (!isRecord(block)) continue
		const type = block.type
		if (type === 'text') {
			const text = asString(block.text)
			if (text === undefined) continue
			events.push({ kind: 'text', text, sessionId, messageId })
		} else if (type === 'tool_use') {
			const id = asString(block.id)
			const name = asString(block.name)
			if (id === undefined || name === undefined) continue
			events.push({ kind: 'tool_use', id, name, input: block.input, sessionId, messageId })
		} else if (type === 'thinking') {
			// The CLI emits two flavours of thinking block:
			//   1. Plain: `{ type: 'thinking', thinking: '...' }` — the model's
			//      internal reasoning, streamed as text.
			//   2. Redacted: `{ type: 'thinking', thinking: '', signature: '...' }`
			//      — Anthropic withholds the content but confirms thinking
			//      happened via a signature. Still surface it so the user sees
			//      "Sindre thought about this" rather than a silent gap.
			const rawText = asString(block.thinking) ?? asString(block.text) ?? ''
			const signature = asString(block.signature)
			const redacted = rawText.length === 0 && signature !== undefined
			if (rawText.length === 0 && !redacted) continue
			events.push({
				kind: 'thinking',
				text: rawText,
				...(redacted ? { redacted: true } : {}),
				sessionId,
				messageId,
			})
		}
	}

	return events
}

function parseResult(envelope: Record<string, unknown>): SindreEvent {
	return {
		kind: 'result',
		subtype: asString(envelope.subtype) ?? 'unknown',
		isError: envelope.is_error === true,
		text: asString(envelope.result),
		durationMs: asNumber(envelope.duration_ms),
		numTurns: asNumber(envelope.num_turns),
		totalCostUsd: asNumber(envelope.total_cost_usd),
		sessionId: asString(envelope.session_id),
	}
}

function parseSystem(envelope: Record<string, unknown>): SindreEvent {
	return {
		kind: 'system',
		subtype: asString(envelope.subtype) ?? 'unknown',
		sessionId: asString(envelope.session_id),
		data: envelope,
	}
}

function parseError(envelope: Record<string, unknown>): SindreEvent {
	const message = asString(envelope.message) ?? asString(envelope.error) ?? 'unknown error'
	return { kind: 'error', message, data: envelope }
}

/**
 * Extract a real user message (typed input) from a `type: 'user'` envelope.
 * The CLI emits two flavours of user envelope: the user's own input echoed
 * back into the conversation (`message.content` is a string, or an array of
 * `text` blocks), and tool-result echoes the SDK injects after each
 * `tool_use` (`message.content` is an array of `tool_result` blocks). Only
 * the former should surface in the transcript — the latter would just
 * duplicate work the matching `tool_use` event already represents.
 */
function parseUserMessage(envelope: Record<string, unknown>): SindreEvent[] {
	const message = envelope.message
	if (!isRecord(message)) return []
	const content = message.content

	if (typeof content === 'string') {
		const trimmed = content.trim()
		if (trimmed.length === 0) return []
		return [{ kind: 'user', text: content }]
	}

	if (Array.isArray(content)) {
		const texts: string[] = []
		for (const block of content) {
			if (!isRecord(block)) continue
			if (block.type === 'text') {
				const text = asString(block.text)
				if (text !== undefined) texts.push(text)
			}
			// `tool_result` blocks are intentionally skipped — the matching
			// `tool_use` event is already in the transcript.
		}
		if (texts.length === 0) return []
		return [{ kind: 'user', text: texts.join('\n') }]
	}

	return []
}

export interface ParseSindreOptions {
	/**
	 * When true, `type: 'user'` envelopes that carry actual user text (not
	 * just tool-result echoes) emit a `kind: 'user'` event. Off by default so
	 * the live Sindre chat — which adds user events client-side on send —
	 * doesn't double up when the CLI echoes the same text back.
	 */
	includeUser?: boolean
}

/**
 * Parse a single stdout log line. Returns an array because one assistant
 * envelope may contain multiple content blocks, each becoming its own event.
 * User echoes and any other recognised-but-uninteresting envelopes return an
 * empty array unless `includeUser` is set.
 */
export function parseSindreLine(line: string, options: ParseSindreOptions = {}): SindreEvent[] {
	const trimmed = line.trim()
	if (trimmed.length === 0) return []

	let envelope: unknown
	try {
		envelope = JSON.parse(trimmed)
	} catch {
		return [{ kind: 'debug', raw: line }]
	}

	if (!isRecord(envelope)) {
		return [{ kind: 'debug', raw: line }]
	}

	const type = asString(envelope.type)
	switch (type) {
		case 'assistant': {
			const events = parseAssistant(envelope)
			if (events === null) return [{ kind: 'debug', raw: line }]
			return events
		}
		case 'user':
			return options.includeUser ? parseUserMessage(envelope) : []
		case 'result':
			return [parseResult(envelope)]
		case 'system':
			return [parseSystem(envelope)]
		case 'error':
			return [parseError(envelope)]
		default:
			return [{ kind: 'debug', raw: line }]
	}
}

/**
 * Parse a chunk of newline-delimited JSON lines. Empty lines are skipped.
 */
export function parseSindreStream(text: string): SindreEvent[] {
	const events: SindreEvent[] = []
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0) continue
		for (const event of parseSindreLine(line)) {
			events.push(event)
		}
	}
	return events
}
