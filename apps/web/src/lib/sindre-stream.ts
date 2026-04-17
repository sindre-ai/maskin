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

export type SindreEvent =
	| { kind: 'text'; text: string; sessionId?: string; messageId?: string }
	| {
			kind: 'tool_use'
			id: string
			name: string
			input: unknown
			sessionId?: string
			messageId?: string
	  }
	| { kind: 'thinking'; text: string; sessionId?: string; messageId?: string }
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
			const text = asString(block.thinking) ?? asString(block.text)
			if (text === undefined) continue
			events.push({ kind: 'thinking', text, sessionId, messageId })
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
 * Parse a single stdout log line. Returns an array because one assistant
 * envelope may contain multiple content blocks, each becoming its own event.
 * User echoes and any other recognised-but-uninteresting envelopes return an
 * empty array.
 */
export function parseSindreLine(line: string): SindreEvent[] {
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
			return []
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
