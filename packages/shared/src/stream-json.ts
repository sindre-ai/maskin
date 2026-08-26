/**
 * Parsing helpers for the Claude Code stream-json protocol.
 *
 * Both the usage extractor (apps/dev/src/services/usage-parser.ts) and the
 * interactive turn finalizer (apps/dev/src/services/interactive-turn-finalizer.ts)
 * need to answer the same question — "is this line a top-level `result`
 * envelope, and what's in it?" — so the answer lives here once.
 */

export type StreamJsonUsage = {
	totalCostUsd: number | null
	inputTokens: number | null
	outputTokens: number | null
	cacheCreationInputTokens: number | null
	cacheReadInputTokens: number | null
	durationMs: number | null
}

export type StreamJsonResult = {
	/** The exact trimmed line as it arrived — the stable dedupe-hash input. */
	raw: string
	/** `obj.result`, the agent's final text for the turn. '' when absent. */
	text: string
	isError: boolean
	/** 'success' | 'error_max_turns' | … — null when the field is absent. */
	subtype: string | null
	usage: StreamJsonUsage
}

const finiteOrNull = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? n : null
}

/**
 * Split a text buffer into complete lines plus a trailing partial remainder.
 *
 * Docker delivers *chunks*, not lines — a chunk can end mid-JSON, and a single
 * chunk can carry several lines. Callers accumulate `remainder` and prepend it
 * to the next chunk. On line-oriented transports (the agent-server ingest path)
 * this is a passthrough: one line in, one line out, empty remainder.
 */
export function splitLines(text: string): { lines: string[]; remainder: string } {
	const parts = text.split('\n')
	const remainder = parts.pop() ?? ''
	return { lines: parts, remainder }
}

/**
 * Parse ONE already-complete line. Returns null unless it is a top-level
 * stream-json `result` envelope.
 *
 * Envelopes carrying `parent_tool_use_id` are sub-agent (Task tool) results and
 * are rejected: they are intermediate output, and surfacing them would leak a
 * sub-agent's internal answer into the chat as if it were the agent's reply.
 */
export function parseResultLine(line: string): StreamJsonResult | null {
	const trimmed = line.trim()
	if (!trimmed || trimmed[0] !== '{') return null

	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null

	const obj = parsed as Record<string, unknown>
	if (obj.type !== 'result') return null
	// Sub-agent result — not the agent's own turn output.
	if (obj.parent_tool_use_id != null) return null

	const usage = (obj.usage ?? {}) as Record<string, unknown>
	return {
		raw: trimmed,
		text: typeof obj.result === 'string' ? obj.result : '',
		isError: obj.is_error === true,
		subtype: typeof obj.subtype === 'string' ? obj.subtype : null,
		usage: {
			totalCostUsd: finiteOrNull(obj.total_cost_usd),
			inputTokens: finiteOrNull(usage.input_tokens),
			outputTokens: finiteOrNull(usage.output_tokens),
			cacheCreationInputTokens: finiteOrNull(usage.cache_creation_input_tokens),
			cacheReadInputTokens: finiteOrNull(usage.cache_read_input_tokens),
			durationMs: finiteOrNull(obj.duration_ms),
		},
	}
}

/**
 * What a scan backwards through a turn's stdout finds on one line.
 *
 * `boundary` marks where the current turn began, so a caller walking backwards
 * knows to stop rather than reaching into the previous turn's output:
 *  - a top-level `result` envelope is the previous turn's close;
 *  - a `user` envelope carrying `maskin_message_id` is this turn's opening
 *    message, persisted by SessionManager.writeInput.
 *
 *  - an `assistant` line calling AskUserQuestion, whose question the hook has
 *    already posted into the chat as its own message.
 *
 * Two shapes deliberately are NOT boundaries. A `user` envelope without that
 * tag is either a tool_result fed back mid-turn or a seeded first turn, and a
 * `result` carrying `parent_tool_use_id` closes a sub-agent's run rather than
 * this turn — stopping on either would abandon the scan inside the very turn
 * it is meant to read. A seeded first turn is safe to walk past because it has
 * no earlier turn to reach into.
 */
export type StreamJsonScanLine =
	| { kind: 'boundary' }
	| { kind: 'assistant_text'; text: string }
	| { kind: 'other' }

/** Tool whose PreToolUse hook posts the question into the chat instead. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * Suffix of the Maskin MCP tool an agent uses to reply into the chat directly.
 * Matched as a suffix because the full tool name is prefixed with the MCP
 * server alias (`mcp__<alias>__post_conversation_message`), which is workspace
 * configuration rather than a constant.
 */
export const POST_MESSAGE_TOOL_SUFFIX = 'post_conversation_message'

/**
 * Classify ONE already-complete line for a backwards turn scan.
 *
 * Exists for the interactive turn finalizer's recovery path: when the `result`
 * envelope carries no text, the agent's actual reply is still sitting in an
 * earlier `assistant` line of the same turn. Assistant messages carrying
 * `parent_tool_use_id` are sub-agent (Task tool) output and are reported as
 * 'other' — surfacing one would leak a sub-agent's internal answer into the
 * chat, the same reason parseResultLine rejects them.
 */
export function scanTurnLine(line: string): StreamJsonScanLine {
	const trimmed = line.trim()
	if (!trimmed || trimmed[0] !== '{') return { kind: 'other' }

	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		return { kind: 'other' }
	}
	if (!parsed || typeof parsed !== 'object') return { kind: 'other' }

	const obj = parsed as Record<string, unknown>

	if (obj.type === 'result') {
		// Mirrors parseResultLine: a sub-agent (Task tool) result is not this
		// turn's close. Treating it as a boundary would abandon recovery in the
		// middle of a turn that dispatched a Task and then ended on a blank
		// result — exactly the turn this scan exists to save.
		return obj.parent_tool_use_id != null ? { kind: 'other' } : { kind: 'boundary' }
	}
	if (obj.type === 'user') {
		return obj.maskin_message_id !== undefined ? { kind: 'boundary' } : { kind: 'other' }
	}
	if (obj.type !== 'assistant') return { kind: 'other' }
	if (obj.parent_tool_use_id != null) return { kind: 'other' }

	const message = obj.message
	if (!message || typeof message !== 'object') return { kind: 'other' }
	const content = (message as Record<string, unknown>).content
	if (!Array.isArray(content)) return { kind: 'other' }

	// Two tool calls end the scan, both because everything before them belongs to
	// a message the human has already been shown:
	//
	//   AskUserQuestion — the PreToolUse hook posts that question into the chat
	//   as its own message and tells the agent to close the turn without a
	//   closing message, which blanks the `result` envelope and so triggers this
	//   very scan. Without a boundary the walk would continue past the call and
	//   recover the narration that led up to it ("let me check which option
	//   you'd prefer…"), posting a stale bubble under the question chips.
	//
	//   post_conversation_message — the agent replied through the MCP tool and
	//   then ended silently, which is the single most common way a turn closes
	//   with a blank `result`. The tool_result comes back as an untagged `user`
	//   envelope, so nothing else here stops the walk: it would recover the
	//   narration around the call ("posted that to the thread") and post it as a
	//   near-duplicate under the reply the agent deliberately wrote. The
	//   finalizer's dedupe cannot catch that — it keys on the `result` line,
	//   not on messages already persisted in the conversation.
	if (
		content.some((block) => {
			if (!block || typeof block !== 'object') return false
			if ((block as { type?: unknown }).type !== 'tool_use') return false
			const name = (block as { name?: unknown }).name
			if (typeof name !== 'string') return false
			return name === ASK_USER_QUESTION_TOOL || name.endsWith(POST_MESSAGE_TOOL_SUFFIX)
		})
	) {
		return { kind: 'boundary' }
	}

	// One streamed `assistant` line can carry several blocks; join the text ones
	// in order and let the caller decide whether the result is worth posting.
	const text = content
		.filter(
			(block): block is { type: 'text'; text: string } =>
				!!block &&
				typeof block === 'object' &&
				(block as { type?: unknown }).type === 'text' &&
				typeof (block as { text?: unknown }).text === 'string',
		)
		.map((block) => block.text)
		.join('')

	return text.trim() ? { kind: 'assistant_text', text } : { kind: 'other' }
}
