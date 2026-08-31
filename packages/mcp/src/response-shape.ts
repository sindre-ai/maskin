// Response-shape measurement — the "why is this response big?" half of the
// size telemetry.
//
// `recordToolCallResponseSize` already reports how many bytes a tool response
// weighs, split across the two channels MCP puts on the wire. That tells you
// which tools are heavy; it does not tell you what to cut. A 40KB
// `list_objects` is a different problem depending on whether it returned 200
// slim rows or 5 rows each carrying a full `content` body, and the fix differs
// too — page smaller vs. project fewer fields.
//
// So this module derives the shape alongside the size: how many rows, how big
// the biggest one is, and which field names account for the bulk.
//
// Privacy contract — identical to `argKeys` in `telemetry.ts`, and it has to
// be, because this walks *response* payloads which are user data end to end.
// Only field NAMES and byte COUNTS leave here. No value is stringified,
// sampled, hashed, or truncated into the output. Names are additionally
// filtered through the same identifier regex the arg-key path uses, because a
// row can carry a `data` jsonb whose keys are workspace-authored free text —
// a key like `"Acquire the Nakatomi account"` is exactly the content this
// event exists to keep out, and it would otherwise ride in wearing the label
// of a schema field. Anything added here later must clear the same bar;
// `response-shape.test.ts` asserts it.

/** Mirrors `ARG_KEY_RE` in `telemetry.ts` — see the privacy note above. */
const FIELD_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/

/** How many field names we report. The point is to name the top offenders,
 *  not to reproduce the schema, and every name is a PostHog dimension. */
const MAX_TOP_FIELDS = 8

/** Rows scanned when attributing bytes to fields. Attribution is a ranking
 *  input, not an accounting one — scanning the whole array on every response
 *  would put an O(payload) serialize on the hot path of every tool call for
 *  a ranking the first page already settles. */
const MAX_ROWS_SAMPLED = 25

export interface ResponseShape {
	/** Rows in the response's row array, or null when it carries no array —
	 *  null, not 0, so "not a list tool" stays distinguishable from
	 *  "a list tool that returned nothing", which is the interesting case. */
	rowCount: number | null
	/** Serialized bytes of the largest single row, or null when there are no
	 *  rows. Paired with `rowCount`, this separates "too many rows" from
	 *  "rows too fat" without needing the raw payload. */
	maxRowBytes: number | null
	/** Blocks in `content` (MCP's text/image array), or null when absent. */
	contentBlockCount: number | null
	/** Field names ranked by total bytes across the sampled rows, heaviest
	 *  first. Names only — see the privacy note. */
	topFields: string[]
	/** Bytes attributed to each entry of `topFields`, positionally aligned. */
	topFieldBytes: number[]
}

export const EMPTY_RESPONSE_SHAPE: ResponseShape = {
	rowCount: null,
	maxRowBytes: null,
	contentBlockCount: null,
	topFields: [],
	topFieldBytes: [],
}

function jsonBytes(value: unknown): number {
	if (value === undefined || value === null) return 0
	try {
		const json = JSON.stringify(value)
		return json ? Buffer.byteLength(json, 'utf8') : 0
	} catch {
		// Circular or otherwise unserializable. It never reached the wire in
		// that state either, so 0 is the honest answer rather than a guess.
		return 0
	}
}

/**
 * Find the row array inside `structuredContent`.
 *
 * Tools differ in what they call it (`objects`, `files`, `sessions`, …) and
 * `response-cap.ts` keeps an explicit per-tool registry for that reason —
 * because it must trim the *right* array or it corrupts the response. This is
 * telemetry, so it can afford to be generic: take the longest top-level array,
 * which is the row array on every list tool we have and harmless to be wrong
 * about anywhere else. Staying registry-free means a new list tool is measured
 * the day it ships instead of the day someone remembers to register it.
 */
function findRows(structuredContent: unknown): unknown[] | null {
	if (Array.isArray(structuredContent)) return structuredContent
	if (!structuredContent || typeof structuredContent !== 'object') return null
	let best: unknown[] | null = null
	for (const value of Object.values(structuredContent as Record<string, unknown>)) {
		if (Array.isArray(value) && (best === null || value.length > best.length)) best = value
	}
	return best
}

/** Total bytes per field name across the sampled rows. Non-object rows (a
 *  bare string array, say) contribute nothing — there are no field names to
 *  attribute to, and their content must not become one. */
function attributeFieldBytes(rows: unknown[]): Map<string, number> {
	const totals = new Map<string, number>()
	for (const row of rows.slice(0, MAX_ROWS_SAMPLED)) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) continue
		for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
			if (!FIELD_NAME_RE.test(key)) continue
			totals.set(key, (totals.get(key) ?? 0) + jsonBytes(value))
		}
	}
	return totals
}

/**
 * Derive the shape of a tool response. Never throws: this runs on the tool-call
 * path, and a measurement fault must cost the metric, not the call.
 */
export function measureResponseShape(content: unknown, structuredContent: unknown): ResponseShape {
	try {
		const rows = findRows(structuredContent)
		const totals = rows ? attributeFieldBytes(rows) : new Map<string, number>()
		const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_FIELDS)
		return {
			rowCount: rows ? rows.length : null,
			maxRowBytes: rows?.length ? Math.max(...rows.map(jsonBytes)) : null,
			contentBlockCount: Array.isArray(content) ? content.length : null,
			topFields: ranked.map(([key]) => key),
			topFieldBytes: ranked.map(([, bytes]) => bytes),
		}
	} catch {
		return EMPTY_RESPONSE_SHAPE
	}
}
