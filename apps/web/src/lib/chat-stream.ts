/**
 * Parser for the Claude Code CLI `--output-format stream-json` log stream
 * that the interactive session emits on stdout. Each stdout log line is
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
	| { kind: 'file'; id?: string; name: string; sizeBytes: number; mimeType?: string }

export type ChatEvent =
	| { kind: 'user'; text: string; attachments?: UserAttachmentView[] }
	| {
			kind: 'text'
			text: string
			attachments?: UserAttachmentView[]
			sessionId?: string
			messageId?: string
	  }
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

function parseAssistant(envelope: Record<string, unknown>): ChatEvent[] | null {
	const message = envelope.message
	if (!isRecord(message)) return null
	const content = message.content
	if (!Array.isArray(content)) return null

	const sessionId = asString(envelope.session_id)
	const messageId = asString(message.id)
	const attachments = parseMaskinAttachments(envelope.maskin_attachments)
	const events: ChatEvent[] = []

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
			//      "The agent thought about this" rather than a silent gap.
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

	// Attach Maskin-only `maskin_attachments` (same round-trip shape as the
	// user side) to the assistant's first text block so the transcript can
	// render agent-referenced items (object cards, files) above the reply.
	if (attachments.length > 0) {
		const firstText = events.find(
			(e): e is Extract<ChatEvent, { kind: 'text' }> => e.kind === 'text',
		)
		if (firstText) {
			firstText.attachments = attachments
		}
	}

	return events
}

function parseResult(envelope: Record<string, unknown>): ChatEvent {
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

function parseSystem(envelope: Record<string, unknown>): ChatEvent {
	return {
		kind: 'system',
		subtype: asString(envelope.subtype) ?? 'unknown',
		sessionId: asString(envelope.session_id),
		data: envelope,
	}
}

function parseError(envelope: Record<string, unknown>): ChatEvent {
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
function parseUserMessage(envelope: Record<string, unknown>): ChatEvent[] {
	const message = envelope.message
	if (!isRecord(message)) return []
	const content = message.content
	const attachments = parseMaskinAttachments(envelope.maskin_attachments)

	const withAttachments = (text: string): ChatEvent => ({
		kind: 'user',
		text,
		...(attachments.length > 0 ? { attachments } : {}),
	})

	if (typeof content === 'string') {
		// An empty string with attachments is still meaningful — e.g. an image-
		// only message sent via the iOS chat composer.
		if (content.trim().length === 0 && attachments.length === 0) return []
		return [withAttachments(content)]
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
		if (texts.length === 0 && attachments.length === 0) return []
		return [withAttachments(texts.join('\n'))]
	}

	return []
}

/**
 * Read the Maskin-only `maskin_attachments` extension we tack onto user
 * envelopes when they're persisted to `session_logs`. Each entry round-trips
 * the kind + id + display metadata the composer dispatched on send, so the
 * transcript can re-render the user bubble — including inline file cards —
 * without a second POST to `/files` on reload.
 */
function parseMaskinAttachments(value: unknown): UserAttachmentView[] {
	if (!Array.isArray(value)) return []
	const out: UserAttachmentView[] = []
	for (const entry of value) {
		if (!isRecord(entry)) continue
		const kind = asString(entry.kind)
		if (kind === 'file') {
			const name = asString(entry.name)
			if (name === undefined) continue
			const sizeBytes = asNumber(entry.size_bytes) ?? 0
			const id = asString(entry.id)
			const mimeType = asString(entry.mime_type)
			out.push({
				kind: 'file',
				name,
				sizeBytes,
				...(id ? { id } : {}),
				...(mimeType ? { mimeType } : {}),
			})
		} else if (kind === 'agent') {
			const id = asString(entry.id)
			if (id === undefined) continue
			out.push({ kind: 'agent', id, name: asString(entry.name) ?? null })
		} else if (kind === 'object') {
			const id = asString(entry.id)
			if (id === undefined) continue
			out.push({
				kind: 'object',
				id,
				title: asString(entry.title) ?? null,
				type: asString(entry.type) ?? null,
			})
		} else if (kind === 'notification') {
			const id = asString(entry.id)
			if (id === undefined) continue
			out.push({ kind: 'notification', id, title: asString(entry.title) ?? null })
		}
	}
	return out
}

export interface ParseChatOptions {
	/**
	 * When true, `type: 'user'` envelopes that carry actual user text (not
	 * just tool-result echoes) emit a `kind: 'user'` event. Off by default so
	 * the live chat — which adds user events client-side on send —
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
export function parseChatLine(line: string, options: ParseChatOptions = {}): ChatEvent[] {
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
export function parseChatStream(text: string): ChatEvent[] {
	const events: ChatEvent[] = []
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0) continue
		for (const event of parseChatLine(line)) {
			events.push(event)
		}
	}
	return events
}
