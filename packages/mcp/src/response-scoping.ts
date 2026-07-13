// MCP response scoping — flag-gated channel split.
//
// When `MCP_RESPONSE_SCOPING` is on, list/search MCP tools swap the historical
// `content: JSON.stringify(enriched, null, 2)` dump for a lean markdown summary
// (one line per row with a deep link). The full enriched payload stays on
// `structuredContent` so callers that read the structured channel see no
// change. When the flag is off, the response is byte-identical to the
// pre-scoping shape.
//
// The flag is read from `process.env` at request time — toggling does NOT
// require a server restart (AC-T4).

/** Environment variable name for the response-scoping master flag. */
export const RESPONSE_SCOPING_ENV_VAR = 'MCP_RESPONSE_SCOPING'

/**
 * Byte budget for the `content` channel when scoping is on. AC-T2 caps the
 * default-page response at 2KB. We reserve a small footer allowance for the
 * "N more not shown" line so the summary stays under budget even when the
 * caller returns the maximum default page size.
 */
export const CONTENT_SUMMARY_BUDGET_BYTES = 2048

/**
 * Read the master flag from the environment on every call. A restart is not
 * required — the deployment can flip the env var and the very next tool call
 * sees the new value.
 *
 * Truthy values (case-insensitive): `1`, `true`, `on`, `yes`. Anything else
 * (including unset, empty, and any other string) is treated as off. Keeping
 * the accepted set small avoids ambiguity: the flag is a hard on/off toggle,
 * not a level.
 */
export function isResponseScopingEnabled(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
	const raw = env[RESPONSE_SCOPING_ENV_VAR]
	if (typeof raw !== 'string') return false
	const normalized = raw.trim().toLowerCase()
	return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes'
}

/** One row in a summary. Title is the human-readable label; url is the
 *  deep link back into the web app; meta is an optional inline suffix
 *  (e.g. `"bet · active"` or `"cron · enabled"`). Fields are copied by the
 *  caller from the enriched row so the summary builder doesn't couple to any
 *  particular tool's response schema. */
export interface SummaryRow {
	title: string
	url?: string
	meta?: string
}

interface BuildContentSummaryOptions {
	/** Text returned when `rows` is empty. Concrete tools pass a specific
	 *  label (e.g. `"No objects."`) so agent-facing output is legible even
	 *  before a `structuredContent` heroCard is rendered. */
	emptyLabel: string
	/** Override the byte budget. Default: `CONTENT_SUMMARY_BUDGET_BYTES`.
	 *  Tests override this to exercise the truncation path. */
	targetBytes?: number
}

/**
 * Render `rows` as a lean markdown summary with a deterministic byte cap.
 *
 * Each row emits one line: `- [{title}]({url}) · {meta}`. Missing url falls
 * back to plain text; missing meta drops the trailing separator. The line
 * budget is filled greedily; the moment the next line would push us over the
 * target, we stop and append `… {N} more not shown; full payload in
 * structuredContent`. That guarantees the returned string stays inside the
 * budget regardless of row count or title length — so the seven list/search
 * MCP tools all respect AC-T2 without a per-tool tuning knob.
 *
 * The escape hatch: the caller has already put the full enriched payload on
 * `structuredContent`, so an agent that needs the omitted rows just reads
 * the structured channel — no extra tool call.
 */
export function buildContentSummary(rows: SummaryRow[], opts: BuildContentSummaryOptions): string {
	if (rows.length === 0) return opts.emptyLabel
	const budget = opts.targetBytes ?? CONTENT_SUMMARY_BUDGET_BYTES
	const footerFor = (dropped: number) =>
		`… ${dropped} more not shown; full payload in structuredContent`
	// Worst-case footer length (max dropped == rows.length) is our reserve.
	// Overestimating is fine — we only use it as a headroom guard.
	const footerReserve = Buffer.byteLength(`\n${footerFor(rows.length)}`, 'utf8')

	const lines: string[] = []
	let byteCount = 0
	let stoppedAt = rows.length

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]
		if (!row) continue
		const line = formatSummaryLine(row)
		const lineBytes = Buffer.byteLength((lines.length === 0 ? '' : '\n') + line, 'utf8')
		const remainingAfterThis = rows.length - i - 1
		const reserve = remainingAfterThis > 0 ? footerReserve : 0
		if (byteCount + lineBytes + reserve > budget && lines.length > 0) {
			stoppedAt = i
			break
		}
		lines.push(line)
		byteCount += lineBytes
	}

	const dropped = rows.length - stoppedAt
	if (dropped > 0) lines.push(footerFor(dropped))
	return lines.join('\n')
}

function formatSummaryLine(row: SummaryRow): string {
	const title = row.title && row.title.length > 0 ? row.title : 'Untitled'
	const label = row.url ? `[${escapeMarkdownLinkText(title)}](${row.url})` : title
	return row.meta ? `- ${label} · ${row.meta}` : `- ${label}`
}

/** Escape the two characters that break a markdown link's display text —
 *  `[` and `]`. Everything else survives untouched so URLs keep their
 *  meaning and non-ASCII titles render normally. */
function escapeMarkdownLinkText(s: string): string {
	return s.replace(/[[\]]/g, (ch) => `\\${ch}`)
}
