import { parseResultLine, splitLines } from '@maskin/shared'

/**
 * What the first turn of a launch tells us about how big the session start is.
 * Counts, numbers and booleans only, never text, so it can ride on an analytics
 * event. Every field is null until the stream has shown it.
 */
export interface FirstCallSize {
	/** Tools the runtime listed in its init envelope. */
	toolCount: number | null
	/**
	 * Input tokens + cache creation tokens + cache read tokens of the first model
	 * call of the launch (the first top-level assistant message), so it counts the
	 * whole size of the first call. Never the bare input-token count: on a Claude
	 * session that leaves out cache reads (one failed session showed 94,032 input
	 * tokens against about 1.19M cache reads) and a cache change would look like a
	 * win. Equal to the first turn's total for a one-call turn, and not summed over
	 * the later calls of a turn that uses tools.
	 */
	firstCallInputTokens: number | null
	/**
	 * The `total_cost_usd` the first turn's `result` envelope reported, as the CLI priced it.
	 * The session manager re-prices the turn for its route before it is sent.
	 */
	firstTurnCostUsd: number | null
	/** Whether the first call read anything from the prompt cache. */
	cacheHit: boolean | null
}

export interface FirstTurnResult {
	size: FirstCallSize
	/** Token usage on the first `result` envelope, for pricing the turn on the route it ran. */
	resultUsage: {
		inputTokens: number | null
		outputTokens: number | null
		cacheCreationInputTokens: number | null
		cacheReadInputTokens: number | null
		totalCostUsd: number | null
	}
}

const MAX_BUFFERED_BYTES = 256 * 1024

const finiteOrNull = (v: unknown): number | null => {
	if (typeof v !== 'number' && typeof v !== 'string') return null
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? n : null
}

/**
 * Reads one launch's stdout, chunk by chunk, until the first turn's `result`
 * envelope, and keeps the three things the first call tells us: the tool count
 * (init envelope), the size of the first model call (first top-level assistant
 * message) and the turn's cost (first top-level `result`). Chunks are not lines,
 * and the init envelope is one of the largest lines a session writes, so the
 * trailing partial line is carried to the next chunk.
 *
 * `feed` returns the finished reading once, on the chunk that holds the first
 * `result`; after that it ignores everything. A replayed log line (a stream that
 * re-attaches) repeats something already seen and changes nothing.
 */
export class FirstCallObserver {
	private carried = ''
	private toolCount: number | null = null
	private firstCallInputTokens: number | null = null
	private cacheHit: boolean | null = null
	private firstMessageId: string | null = null
	private finished = false

	get done(): boolean {
		return this.finished
	}

	feed(chunk: string): FirstTurnResult | null {
		if (this.finished || chunk.length === 0) return null
		const { lines, remainder } = splitLines(this.carried + chunk)
		this.carried = remainder.length > MAX_BUFFERED_BYTES ? '' : remainder
		for (const line of lines) {
			const finished = this.readLine(line)
			if (finished) {
				this.finished = true
				this.carried = ''
				return finished
			}
		}
		return null
	}

	private readLine(line: string): FirstTurnResult | null {
		// Cheap string checks first: almost every line is none of the three.
		if (line.includes('"type":"result"')) {
			const result = parseResultLine(line)
			if (!result) return null
			return {
				size: {
					toolCount: this.toolCount,
					firstCallInputTokens: this.firstCallInputTokens,
					firstTurnCostUsd: result.usage.totalCostUsd,
					cacheHit: this.cacheHit,
				},
				resultUsage: {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
					cacheReadInputTokens: result.usage.cacheReadInputTokens,
					totalCostUsd: result.usage.totalCostUsd,
				},
			}
		}
		const isInit = this.toolCount === null && line.includes('"subtype":"init"')
		const isAssistant = this.firstMessageId === null && line.includes('"type":"assistant"')
		if (!isInit && !isAssistant) return null
		let obj: Record<string, unknown>
		try {
			obj = JSON.parse(line)
		} catch {
			return null
		}
		if (!obj || typeof obj !== 'object') return null
		if (isInit && obj.type === 'system' && obj.subtype === 'init' && Array.isArray(obj.tools)) {
			this.toolCount = obj.tools.length
		} else if (isAssistant && obj.type === 'assistant' && obj.parent_tool_use_id == null) {
			const message = obj.message as { id?: unknown; usage?: unknown } | undefined
			const usage = message?.usage as Record<string, unknown> | undefined
			if (typeof message?.id !== 'string' || !usage || typeof usage !== 'object') return null
			const parts = [
				finiteOrNull(usage.input_tokens),
				finiteOrNull(usage.cache_creation_input_tokens),
				finiteOrNull(usage.cache_read_input_tokens),
			]
			if (parts.every((p) => p === null)) return null
			this.firstMessageId = message.id
			this.firstCallInputTokens = parts.reduce<number>((sum, p) => sum + (p ?? 0), 0)
			this.cacheHit = (parts[2] ?? 0) > 0
		}
		return null
	}
}
