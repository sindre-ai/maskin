import { parseResultLine, splitLines } from '@maskin/shared'
import { knownContextWindow } from './model-catalog'

/**
 * How full a session's context window is, read from its stdout. Numbers and
 * booleans only, never text, so a reading can ride on an analytics event.
 */
export interface TurnSizeReading {
	/**
	 * Input + cache creation + cache read tokens of the LAST top-level model call of the turn:
	 * the size of the window the next call starts from. Not the turn's `result` usage, which adds
	 * up every model call of the turn and reads far too big for a turn with tools. When the
	 * assistant lines carry no usage (DeepSeek writes zeros), a count from the log stands in: see
	 * `sizeSource`. Null when neither gives a number.
	 */
	lastTurnWindowTokens: number | null
	/** Where `lastTurnWindowTokens` came from, null when it is null. */
	sizeSource: SizeSource | null
	/** The window the CLI reports for the session's model (`modelUsage.*.contextWindow`), largest seen. */
	contextWindowTokens: number | null
	/** How many times the CLI compacted the conversation since the previous turn closed. */
	compactionsInTurn: number
	isError: boolean
	/** The turn's final text. Read in memory only, never put on an event. */
	text: string
	subtype: string | null
	/** The result line's `api_error` code (for example `autocompact_thrashing`), when it carries one. */
	apiError: string | null
	/** The result line's `terminal_reason` code (for example `rapid_refill_breaker`), when it carries one. */
	terminalReason: string | null
}

/**
 * `assistant_usage`: the usage on the last top-level assistant line. `log_estimate`: characters of
 * the session's own lines since the last compaction, at 4 per token. It reads low (no system
 * prompt or tool list) and starts from zero when the backend restarts, so it only stands in when
 * the assistant lines carry no usage.
 */
export type SizeSource = 'assistant_usage' | 'log_estimate'

const MAX_BUFFERED_BYTES = 256 * 1024
const CHARS_PER_TOKEN = 4

const finiteOrNull = (v: unknown): number | null => {
	if (typeof v !== 'number' && typeof v !== 'string') return null
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? n : null
}

/**
 * Reads one session's stdout, chunk by chunk, and returns one reading per top-level `result`
 * envelope (one per turn of an interactive session). Keeps the usage of the newest top-level
 * `assistant` line, because that is the size of the window; the `result` line sums every call.
 *
 * stream-json writes one `assistant` line per content block and repeats the message's usage on
 * each, so the newest line wins. Chunks are not lines: a trailing partial line is carried to the
 * next chunk. A replayed line (a stream that re-attaches) repeats something already seen and
 * only ever overwrites the last-call figure with the same number.
 */
export class TurnSizeObserver {
	private carried = ''
	private lastCallTokens: number | null = null
	private logChars = 0
	private compactions = 0

	/** Compactions seen since the last `result`: for a session with no turns, the whole run so far. */
	get pendingCompactions(): number {
		return this.compactions
	}

	feed(chunk: string): TurnSizeReading[] {
		if (chunk.length === 0) return []
		const { lines, remainder } = splitLines(this.carried + chunk)
		this.carried = remainder.length > MAX_BUFFERED_BYTES ? '' : remainder
		const readings: TurnSizeReading[] = []
		for (const line of lines) {
			const reading = this.readLine(line)
			if (reading) readings.push(reading)
		}
		return readings
	}

	private readLine(line: string): TurnSizeReading | null {
		// Cheap string checks first: almost every line is none of the three.
		if (line.includes('"type":"result"')) {
			const result = parseResultLine(line)
			if (!result) return null
			const estimate = Math.ceil(this.logChars / CHARS_PER_TOKEN)
			const size =
				this.lastCallTokens !== null
					? { tokens: this.lastCallTokens, source: 'assistant_usage' as const }
					: estimate > 0
						? { tokens: estimate, source: 'log_estimate' as const }
						: null
			const reading: TurnSizeReading = {
				lastTurnWindowTokens: size?.tokens ?? null,
				sizeSource: size?.source ?? null,
				contextWindowTokens: readContextWindow(result.raw),
				compactionsInTurn: this.compactions,
				isError: result.isError,
				text: result.text,
				subtype: result.subtype,
				...readFailureCodes(result.raw),
			}
			this.lastCallTokens = null
			this.compactions = 0
			return reading
		}
		if (line.includes('"subtype":"compact_boundary"')) {
			this.compactions += 1
			// The window just shrank: a figure from before the compaction is stale.
			this.lastCallTokens = null
			this.logChars = 0
			return null
		}
		const isAssistant = line.includes('"type":"assistant"')
		// What the model sees: its own lines and the tool results written back as user lines.
		// A sub-agent's lines (a string parent id) are not in this window.
		if (
			(isAssistant || line.includes('"type":"user"')) &&
			!line.includes('"parent_tool_use_id":"')
		) {
			this.logChars += line.length
		}
		if (!isAssistant) return null
		let obj: Record<string, unknown>
		try {
			obj = JSON.parse(line)
		} catch {
			return null
		}
		if (!obj || obj.type !== 'assistant' || obj.parent_tool_use_id != null) return null
		const usage = (obj.message as { usage?: unknown } | undefined)?.usage as
			| Record<string, unknown>
			| undefined
		if (!usage || typeof usage !== 'object') return null
		const parts = [
			finiteOrNull(usage.input_tokens),
			finiteOrNull(usage.cache_creation_input_tokens),
			finiteOrNull(usage.cache_read_input_tokens),
		]
		const total = parts.reduce<number>((sum, p) => sum + (p ?? 0), 0)
		// Some routes (DeepSeek through OpenRouter, 16 Oct) write every assistant line with zero
		// input tokens and null cache fields: that is a missing reading, not an empty window.
		// Keeping it would read 0 and size rotation would never fire.
		if (total <= 0) return null
		this.lastCallTokens = total
		return null
	}
}

function readFailureCodes(
	rawResultLine: string,
): Pick<TurnSizeReading, 'apiError' | 'terminalReason'> {
	try {
		const obj = JSON.parse(rawResultLine) as { api_error?: unknown; terminal_reason?: unknown }
		return {
			apiError: typeof obj.api_error === 'string' ? obj.api_error : null,
			terminalReason: typeof obj.terminal_reason === 'string' ? obj.terminal_reason : null,
		}
	} catch {
		return { apiError: null, terminalReason: null }
	}
}

function readContextWindow(rawResultLine: string): number | null {
	try {
		const modelUsage = (JSON.parse(rawResultLine) as { modelUsage?: unknown }).modelUsage
		if (!modelUsage || typeof modelUsage !== 'object') return null
		let largest: number | null = null
		for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
			const window = finiteOrNull((entry as { contextWindow?: unknown } | null)?.contextWindow)
			if (window !== null && window > 0 && (largest === null || window > largest)) largest = window
		}
		return largest
	} catch {
		return null
	}
}

/** The CLI window for a model it knows nothing about, and the one assumed when nothing is reported. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

/** Rotate at this share of the window the session reports... */
export const ROTATION_WINDOW_SHARE = 0.6
/** ...but never later than this many tokens. A judgment number: tune after the first week of events. */
export const ROTATION_MAX_TOKENS = 150_000

/**
 * The size, in tokens, at which a chat session is restarted: 60% of the window the session
 * reports, capped at 150k. DeepSeek (1M) gets 150k, a 200k Claude model gets 120k. With no
 * reported window it falls back to the window Maskin knows for the model, then to 200k.
 */
export function rotationLineTokens(
	reportedWindow: number | null,
	modelName?: string | null,
): number {
	const window = reportedWindow ?? knownContextWindow(modelName) ?? DEFAULT_CONTEXT_WINDOW_TOKENS
	return Math.min(Math.floor(window * ROTATION_WINDOW_SHARE), ROTATION_MAX_TOKENS)
}

export type SizeBucket =
	| 'unknown'
	| 'lt_100k'
	| '100k_150k'
	| '150k_200k'
	| '200k_400k'
	| 'gte_400k'

/** A coarse bucket for the size of a window, so an event carries a label and not a raw number. */
export function sizeBucket(tokens: number | null): SizeBucket {
	if (tokens === null) return 'unknown'
	if (tokens < 100_000) return 'lt_100k'
	if (tokens < 150_000) return '100k_150k'
	if (tokens < 200_000) return '150k_200k'
	if (tokens < 400_000) return '200k_400k'
	return 'gte_400k'
}

/** How many compactions in one turn count as the CLI looping on it. */
export const COMPACTION_LOOP_THRESHOLD = 2

/**
 * Which way a closed turn shows the window failing, or null. Only an error turn can be a
 * failure; a compaction that happened and worked is no failure. Read from the CLI's error text,
 * which is not a contract: the phrases below come from the CLI's own wording and from the 16 Oct
 * failed runs (autocompact came back empty, then the session failed), so a miss leaves the
 * session ending as it does today, never wrongly restarted.
 */
export function classifyContextFailure(
	reading: Pick<TurnSizeReading, 'isError' | 'text' | 'compactionsInTurn'> &
		Partial<Pick<TurnSizeReading, 'apiError' | 'terminalReason'>>,
): 'compaction_failed' | 'context_full' | null {
	if (reading.compactionsInTurn >= COMPACTION_LOOP_THRESHOLD) return 'compaction_failed'
	if (!reading.isError) return null
	// The CLI's own codes, seen on the 16 Oct failed DeepSeek runs: steadier than its wording.
	if (
		reading.apiError === 'autocompact_thrashing' ||
		reading.terminalReason === 'rapid_refill_breaker'
	) {
		return 'compaction_failed'
	}
	const text = reading.text
	if (
		/(?:auto-?)?compact\w*[^.\n]{0,80}(?:fail|error|empty|unable|could not|interrupt|thrash)|(?:fail|error)[^.\n]{0,60}compact|not enough messages to compact/i.test(
			text,
		)
	) {
		return 'compaction_failed'
	}
	if (
		/prompt is too long|conversation too long|context (?:length|window)[^.\n]{0,60}(?:exceed|full|limit)|exceeds? the (?:model'?s )?(?:maximum )?context|maximum context length|too many tokens/i.test(
			text,
		)
	) {
		return 'context_full'
	}
	return null
}
