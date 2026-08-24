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
