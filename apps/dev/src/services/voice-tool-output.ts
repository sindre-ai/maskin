// Fitting a tool result into one Realtime turn.
//
// A live call hands the model the text of a tool result, capped so one big read cannot flood a
// turn. The cap used to slice the text at a character count. For a list that cuts a row in half,
// leaves invalid JSON, and says nothing about how much is missing, so a model that asked for a
// hundred rows saw twenty-odd and no sign that the rest existed. It then reported a connected
// integration as missing (a live Slack row was past the cut).
//
// A JSON result with a list in it is cut by rows instead: whole rows are dropped from the tail,
// the result stays valid JSON, and it says how many were left out and what to do about it.

const OMITTED_NOTE =
	'This result was too long for a call, so some rows were left out. Do not treat a row you do not see as missing: say the list is incomplete, then ask again with a filter (for example provider, status or q) or a smaller limit.'

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The list inside a result: the result itself, or its longest top-level array. */
function findRows(parsed: unknown): { key: string | null; rows: unknown[] } | null {
	if (Array.isArray(parsed)) return { key: null, rows: parsed }
	if (!isRecord(parsed)) return null
	let best: { key: string; rows: unknown[] } | null = null
	for (const [key, value] of Object.entries(parsed)) {
		if (Array.isArray(value) && (!best || value.length > best.rows.length)) {
			best = { key, rows: value }
		}
	}
	return best
}

/** A page block that kept saying "this is the last page" would now be wrong. */
function adjustPage(page: unknown, shown: number): unknown {
	if (!isRecord(page)) return page
	return {
		...page,
		...(typeof page.returned === 'number' ? { returned: shown } : {}),
		...(typeof page.has_more === 'boolean' ? { has_more: true } : {}),
	}
}

function build(parsed: unknown, key: string | null, kept: unknown[], total: number): string {
	const notice = { omitted: total - kept.length, shown: kept.length, of: total, note: OMITTED_NOTE }
	if (key === null) return JSON.stringify({ voice_truncated: notice, rows: kept })
	const source = parsed as Json
	const out: Json = { voice_truncated: notice }
	for (const [k, v] of Object.entries(source)) {
		out[k] = k === key ? kept : k === 'page' ? adjustPage(v, kept.length) : v
	}
	return JSON.stringify(out)
}

/**
 * `text` unchanged when it fits. Otherwise, for JSON with a list in it, the longest run of whole
 * leading rows that fits, plus a `voice_truncated` notice. Anything else is sliced at `max`
 * characters and marked, as before.
 */
export function capToolOutput(text: string, max: number): string {
	if (text.length <= max) return text
	const sliced = () => `${text.slice(0, max)}… [truncated]`

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return sliced()
	}
	const found = findRows(parsed)
	if (!found || found.rows.length === 0) return sliced()

	// Drop rows from the tail until it fits. Rows are measured once, so this is linear in the
	// number of rows, not a re-serialisation per attempt.
	const { key, rows } = found
	const overhead = build(parsed, key, [], rows.length).length
	let used = overhead
	let keep = 0
	for (const row of rows) {
		const size = JSON.stringify(row).length + 1
		if (used + size > max) break
		used += size
		keep++
	}
	// Not even one whole row fits: a half row is worse than the plain cut.
	if (keep === 0) return sliced()

	// The notice's own digits can add a few characters; give up a row rather than overshoot.
	for (; keep > 0; keep--) {
		const result = build(parsed, key, rows.slice(0, keep), rows.length)
		if (result.length <= max) return result
	}
	return sliced()
}
