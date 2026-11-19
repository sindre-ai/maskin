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
	 *
	 * Why summing is right on each route (read from the code, not from a live
	 * session): every route runs the same Claude CLI and reads the same Anthropic
	 * usage block, where input, cache creation and cache read are three separate
	 * buckets and input leaves out what came from the cache.
	 * - claude_oauth, workspace_api_key, agent_api_key: the Anthropic API itself.
	 *   The 94,032 input against 1.19M cache reads above only fits separate buckets.
	 * - maskin_plan (DeepSeek and others, through OpenRouter's Anthropic-compatible
	 *   endpoint) and workspace_custom: same block. resolveSessionCostUsd in
	 *   usage-parser.ts bills the three at separate prices, and
	 *   scripts/openrouter-conformance.mjs adds the three as the prompt total of a
	 *   DeepSeek run. So the repo treats cached tokens as separate from input on
	 *   that route too, and nothing is added twice. A recorded DeepSeek session shows input 15 with
	 *   both cache fields 0 (claude-empty-completion-turn.jsonl).
	 * Still to confirm on a real DeepSeek session with cache reads: see the
	 * post-deploy check in the PR.
	 */
	firstCallInputTokens: number | null
	/**
	 * The `total_cost_usd` the first turn's `result` envelope reported, as the CLI priced it.
	 * Not safe to send: on a route that does not reach Anthropic it is a made-up figure.
	 * The session manager replaces it with `resolveRecordedCostUsd` (a recorded cost, or
	 * empty) before the event goes out.
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

/**
 * What agent-run.sh says about the size of the start prompt it built, from its one
 * `[system] start prompt size:` line. Numbers and a boolean, never text.
 */
export interface StartPromptSize {
	/** Bytes of the persona prompt (the system prompt the agent started with). */
	personaBytes: number
	/** Bytes of the whole start prompt: context file plus the opening action prompt. */
	totalBytes: number
	/** Bytes of the consolidated learnings file actually pasted. */
	learningsBytes: number
	/** True when the file was longer than the cap and was cut. */
	learningsCapped: boolean
}

const START_PROMPT_SIZE_RE =
	/\[system\] start prompt size: persona_bytes=(\d+) total_bytes=(\d+) learnings_bytes=(\d+) learnings_capped=(true|false)/

export function parseStartPromptSizeLine(line: string): StartPromptSize | null {
	const m = START_PROMPT_SIZE_RE.exec(line)
	if (!m) return null
	return {
		personaBytes: Number(m[1]),
		totalBytes: Number(m[2]),
		learningsBytes: Number(m[3]),
		learningsCapped: m[4] === 'true',
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
	private startPrompt: StartPromptSize | null = null

	get done(): boolean {
		return this.finished
	}

	/** The start prompt size agent-run.sh reported, once its line has gone by. */
	get startPromptSize(): StartPromptSize | null {
		return this.startPrompt
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
		// Cheap string checks first: almost every line is none of the four.
		if (this.startPrompt === null && line.includes('[system] start prompt size:')) {
			this.startPrompt = parseStartPromptSizeLine(line)
			return null
		}
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
