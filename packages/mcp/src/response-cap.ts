// MCP response token cap — the last guardrail before a tool response ships.
//
// When the fully-serialized response would push a client (Claude Code caps
// tool results at 25,000 tokens) over budget, this wrapper drops complete
// rows from the tail of `structuredContent`, populates
// `_meta.truncated = true` and `_meta.fetch_handle = { tool, ids }`, and
// leaves it to the caller to re-fetch the omitted rows via the get-by-id
// counterpart. Applied unconditionally on every response.
//
// Reuses T1's `bytes/4` token estimator so the cap check and the response-
// size telemetry event count tokens the same way — otherwise the wrapper
// could clear the gate while telemetry reports over-budget (or vice versa).
//
// Row-carrying tools registered here:
//
//   get_objects               → get_objects (batch, `object.id`)
//   get_comments              → no get-by-id counterpart, resumes by cursor
//   list_objects              → get_objects (batch, `ids`)
//   search_objects            → get_objects (batch, `ids`)
//   list_files                → get_file    (single, `id`)
//   list_workspace_skills     → get_workspace_skill (single, `name`)
//   list_relationships        → no get-by-id counterpart — see below
//   list_loops                → get_loop    (single, `id`)
//   list_sessions             → get_session (single, `id`)
//   list_unread               → no get-by-id counterpart
//   list_integrations         → no get-by-id counterpart
//   list_integration_providers → no get-by-id counterpart
//   list_extensions           → no get-by-id counterpart (list_marketplace is a
//                               different operation)
//
// `list_actors` / `list_workspaces` / `list_triggers` are omitted deliberately:
// their `structuredContent` carries only the `heroCard.objects` array (plus,
// on `list_triggers`, the page block and `next_cursor`; sized
// to whatever the cursor walk returned this page — up to LIST_ENDPOINT_MAX_LIMIT
// - 1), not a separately-paginated rich row array like the tools above.
// `list_actors` does fold a bounded amount of extra data onto each row
// (`connectedTriggers`/`connectedLoops`, capped per-actor at
// MAX_CONNECTED_LINKS_PER_ACTOR in server.ts) but is still left out here —
// real workspaces don't approach the size needed to threaten the token
// ceiling, and there's no natural get-by-id row to recover a trimmed actor
// the way `list_objects` has `get_objects`.
//
// `list_relationships` — and the other tools without a `fetchHandleTool` —
// carry rows whose enriched fields (titles, config blobs, extension type
// definitions, etc.) can bust the cap on real workspaces. Trimmed rows without
// a `fetchHandleTool` have no one-hop recovery — instead `rewriteNextCursor`
// below redirects `next_cursor` to point right after the last row still
// present in `structuredContent`, so a follow-up call with that cursor
// returns exactly the trimmed tail next (an extra round trip, but no
// permanently unrecoverable rows).

import { decodeCursor, encodeCursor } from './cursor'
import { estimateTokensFromBytes } from './telemetry'

/** Environment override for the per-response token cap. Unset → default. */
export const RESPONSE_TOKEN_CAP_ENV_VAR = 'MCP_RESPONSE_MAX_TOKENS'

/**
 * Default per-response token budget. Sits well under the Claude Code 25K
 * hard ceiling so the wrapper leaves headroom for MCP envelope overhead and
 * downstream tokenizer variance between our `bytes/4` estimate and the
 * client's actual tokenizer.
 */
export const DEFAULT_MAX_RESPONSE_TOKENS = 15_000

/**
 * `fetch_handle.ids` upper bound. Matches the tightest tool-facing schema
 * constraint across get-by-id counterparts — `get_objects` accepts up to 50
 * ids per call (`packages/mcp/src/tools.ts` `.max(50)`). Anything larger
 * would produce a fetch_handle the client can't act on in one hop, so
 * bumping one side without the other regresses AC-T6 silently. When the
 * trimmed tail carries more than this many rows the wrapper also rewrites
 * `next_cursor` to point at the last recoverable row — otherwise ids past
 * the cap would be silently unrecoverable via either channel.
 */
export const MAX_FETCH_HANDLE_IDS = 50

/**
 * Registry of tools whose `structuredContent` carries a rich row array that
 * may need trimming. `rowsField` is the key in `structuredContent` that
 * holds the array. `fetchHandleTool`, when set, is the get-by-id counterpart
 * used to populate `_meta.fetch_handle`; `idField` is the property on each
 * row whose value becomes an entry in `fetch_handle.ids` (default `id`;
 * `list_workspace_skills` uses `name`). When `fetchHandleTool` is omitted
 * (`list_relationships`), trimmed rows have no one-hop recovery — the cursor
 * rewrite in `rewriteNextCursor` is the only recovery path.
 */
export interface TokenCapDescriptor {
	fetchHandleTool?: string
	rowsField: string
	/** Property on each row that holds its id. A dotted path reaches into a nested row (`object.id`). */
	idField?: string
	/** Plain words on how to ask for less, appended to the truncation notice. */
	narrowHint?: string
	/** The notice names the omitted ids (up to MAX_FETCH_HANDLE_IDS), for a client that reads only the text. */
	listOmittedIds?: boolean
	/**
	 * `content[0].text` has its own shape (not a copy of `structuredContent`). Trim that shape in place
	 * instead of replacing it with the structured copy, and cut the long text fields of a lone row that
	 * is still over the cap.
	 */
	keepContentShape?: boolean
}

export const TOKEN_CAP_TARGETS: Record<string, TokenCapDescriptor> = {
	get_objects: {
		fetchHandleTool: 'get_objects',
		rowsField: 'objects',
		idField: 'object.id',
		listOmittedIds: true,
		keepContentShape: true,
		narrowHint:
			'Ask for fewer ids per call, or leave out the include blocks (events, relationships, connected_objects, files) you do not need.',
	},
	get_comments: {
		rowsField: 'comments',
		keepContentShape: true,
		narrowHint: 'Ask for a smaller limit to get shorter pages.',
	},
	list_objects: { fetchHandleTool: 'get_objects', rowsField: 'objects' },
	search_objects: { fetchHandleTool: 'get_objects', rowsField: 'objects' },
	list_files: { fetchHandleTool: 'get_file', rowsField: 'files' },
	list_workspace_skills: {
		fetchHandleTool: 'get_workspace_skill',
		rowsField: 'skills',
		idField: 'name',
	},
	list_relationships: { rowsField: 'relationships' },
	list_loops: { fetchHandleTool: 'get_loop', rowsField: 'loops' },
	list_sessions: { fetchHandleTool: 'get_session', rowsField: 'sessions' },
	list_unread: { rowsField: 'items' },
	list_integrations: { rowsField: 'integrations' },
	list_integration_providers: { rowsField: 'providers' },
	list_extensions: { rowsField: 'extensions' },
}

/**
 * Read the token-cap override from the environment on every call. A restart
 * is not required — the deployment can flip the env var and the very next
 * tool call sees the new value. Invalid values (non-numeric, ≤ 0) fall back
 * to `DEFAULT_MAX_RESPONSE_TOKENS`; log spam on a bad value is not worth it
 * because the default is already a safe floor.
 */
export function getMaxResponseTokens(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
	const raw = env[RESPONSE_TOKEN_CAP_ENV_VAR]
	if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MAX_RESPONSE_TOKENS
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_RESPONSE_TOKENS
	return Math.floor(parsed)
}

/**
 * Symbol-keyed (so it never serializes) hook a list tool attaches to its
 * response when a cursor walk must resume right after the last row that ships.
 * `rewriteNextCursor` can only rewrite a cursor the tool already emitted — it
 * cannot start one on a final page, and it reads `createdAt` even when the walk
 * is keyed on `updatedAt` — so the tool, which knows the walk's snapshot, order
 * and sort column, builds the cursor itself from the last shipped row.
 */
export const RESUME_CURSOR = Symbol('resumeCursor')
export type ResumeCursorFn = (lastShippedRow: unknown) => string | null

interface MutableMcpResponse {
	[RESUME_CURSOR]?: ResumeCursorFn
	content?: unknown
	structuredContent?: Record<string, unknown>
	_meta?: Record<string, unknown>
	[key: string]: unknown
}

export interface FetchHandle {
	tool: string
	ids: string[]
}

export interface ApplyResponseTokenCapResult {
	/** The (possibly-trimmed) response value ready to hand back to the SDK. */
	response: unknown
	/** True iff rows were dropped — matches the value we write to `_meta.truncated`. */
	truncated: boolean
}

/**
 * Measure the serialized response's token count against the configured cap
 * and, if over, trim complete rows from `structuredContent` until it fits.
 *
 * Cheap path: any tool not in `TOKEN_CAP_TARGETS`, or any response with an
 * empty/absent rows array, is passed through unchanged. That covers ~90% of
 * calls (get-by-id, mutations, workspace-schema, etc.).
 *
 * Trim path: iteratively pop the tail row into `omitted`, rebuild the
 * response with `_meta.truncated = true` + `_meta.fetch_handle`, and
 * re-measure. As soon as we drop under the cap, return. The trim stops at
 * one row: if that row alone is over the cap (one huge row, large `_meta`),
 * it ships anyway, so a cursor walk always advances past it.
 *
 * `content` now carries the same full-JSON payload as `structuredContent`
 * (list/search tools no longer emit a separately-bounded lean-markdown
 * summary), so every trim also rewrites `content[0].text` to mirror the
 * capped `structuredContent` — otherwise the untrimmed text channel would
 * keep the full row count on the wire and the loop could never converge
 * under the token cap.
 *
 * The response argument is not mutated — we build a shallow copy of
 * `structuredContent`, `content`, and `_meta` on every trim so callers
 * holding a reference to the original see nothing change.
 */
export function applyResponseTokenCap(
	toolName: string,
	response: unknown,
	opts?: { maxTokens?: number; env?: NodeJS.ProcessEnv | Record<string, string | undefined> },
): ApplyResponseTokenCapResult {
	const recordTarget = RECORD_CAP_TARGETS[toolName]
	if (recordTarget) return applyRecordTokenCap(recordTarget, response, opts)
	const target = TOKEN_CAP_TARGETS[toolName]
	if (!target) return { response, truncated: false }
	if (response == null || typeof response !== 'object') return { response, truncated: false }

	const rsp = response as MutableMcpResponse
	const structured = rsp.structuredContent
	if (!structured || typeof structured !== 'object') return { response, truncated: false }

	const rowsRaw = structured[target.rowsField]
	if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) return { response, truncated: false }

	const maxTokens = opts?.maxTokens ?? getMaxResponseTokens(opts?.env)
	if (estimateResponseTokens(response) <= maxTokens) return { response, truncated: false }

	const idField = target.idField ?? 'id'
	const rows = [...(rowsRaw as unknown[])]
	const omitted: unknown[] = []

	// Drop from the tail until we fit, but never below one row. A page that
	// ships zero rows leaves a cursor walk nowhere to resume from (the first
	// row of the next page is the one that did not fit), so the walk would
	// stall on it. One row alone may sit over the cap; the cap leaves headroom
	// under the client's hard ceiling for that. The while-loop is bounded by
	// `rows.length` — no risk of runaway iteration even if the estimator is flaky.
	let candidate: MutableMcpResponse | undefined
	while (rows.length > 1) {
		const dropped = rows.pop()
		omitted.unshift(dropped)
		candidate = buildCappedResponse(rsp, structured, target, rows, {
			tool: target.fetchHandleTool,
			ids: target.fetchHandleTool ? extractIds(omitted, idField) : [],
			omittedRows: omitted,
		})
		if (estimateResponseTokens(candidate) <= maxTokens) break
	}

	// A lone row that is still over the cap cannot lose rows. Tools that opt in
	// have its longest text fields cut instead, and say so in the payload.
	if (target.keepContentShape && estimateResponseTokens(candidate ?? rsp) > maxTokens) {
		const base = candidate ?? (rsp as MutableMcpResponse)
		const shrunk = cutOversizedRow(base, maxTokens)
		if (shrunk) return { response: shrunk, truncated: true }
	}

	// A single-row page has nothing to drop, so it ships as it came.
	if (!candidate) return { response, truncated: false }
	return { response: candidate, truncated: true }
}

interface TrimResult {
	tool?: string
	ids: string[]
	omittedRows: unknown[]
}

function buildCappedResponse(
	rsp: MutableMcpResponse,
	structured: Record<string, unknown>,
	target: TokenCapDescriptor,
	keptRows: unknown[],
	fetchHandle: TrimResult,
): MutableMcpResponse {
	const rowsField = target.rowsField
	// Cap the fetch_handle.ids at MAX_FETCH_HANDLE_IDS so a single hop of
	// `fetch_handle.tool(ids)` stays within the get-by-id schema's cap.
	const cappedIds = fetchHandle.ids.slice(0, MAX_FETCH_HANDLE_IDS)
	const meta: Record<string, unknown> = { ...(rsp._meta ?? {}), truncated: true }
	if (fetchHandle.tool) {
		meta.fetch_handle = { tool: fetchHandle.tool, ids: cappedIds } satisfies FetchHandle
	}
	// When the omitted rows have more one-hop recoverable rows (via
	// fetch_handle) than were actually omitted, the inherited `next_cursor`
	// already points past every omitted row (it was computed from the full,
	// pre-trim page), so no rewrite is needed. Otherwise — including tools
	// with no `fetchHandleTool` at all, i.e. zero rows recoverable in one hop
	// — rows past what's directly recoverable would be silently unreachable
	// unless the cursor is redirected to resume right after the last row the
	// client actually has (the last kept row, or the last fetch_handle-backed
	// row, whichever is later), so a follow-up list call picks up the gap.
	const cappedStructured = syncReturnedCount(
		rewriteNextCursor(
			{ ...structured, [rowsField]: keptRows },
			keptRows,
			fetchHandle.omittedRows,
			fetchHandle.tool ? cappedIds.length : 0,
		),
		keptRows.length,
	)
	const resumedStructured = markTruncated(
		resumeAfterKept(rsp, cappedStructured, keptRows, target.idField ?? 'id'),
		{
			kept: keptRows.length,
			omitted: fetchHandle.omittedRows.length,
			target,
			fetchTool: fetchHandle.tool,
			omittedIds: target.listOmittedIds ? cappedIds : [],
		},
	)
	return {
		...rsp,
		content: target.keepContentShape
			? trimContentInPlace(rsp.content, resumedStructured, target, fetchHandle.omittedRows)
			: capContentToStructured(rsp.content, resumedStructured),
		structuredContent: resumedStructured,
		_meta: meta,
	}
}

/**
 * Mirror `content[0].text` to the just-trimmed `structuredContent` so the
 * text channel shrinks in lockstep with the row cap instead of shipping the
 * full, pre-trim payload on every iteration of the trim loop. Only rewrites
 * the shape every list/search tool actually emits — a single `{ type:
 * 'text' }` block — and leaves anything else (e.g. a tool with no `content`
 * channel at all) untouched.
 */
function capContentToStructured(
	content: unknown,
	cappedStructured: Record<string, unknown>,
): unknown {
	if (!Array.isArray(content) || content.length !== 1) return content
	const block = content[0]
	if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') {
		return content
	}
	return [{ type: 'text', text: JSON.stringify(cappedStructured) }]
}

/**
 * For tools whose `content[0].text` has its own shape (a bare array of per-id results for
 * `get_objects`, a `{ page, next_cursor, comments }` page for `get_comments`), keep that shape and
 * only take the omitted rows out of it. The text is the half a live voice call reads, so a
 * trimmed reply still tells it what was cut: an array has no room for a notice, so one more text
 * block carries it; an object gets the notice fields in place.
 */
function trimContentInPlace(
	content: unknown,
	cappedStructured: Record<string, unknown>,
	target: TokenCapDescriptor,
	omittedRows: unknown[],
): unknown {
	if (!Array.isArray(content) || content.length === 0) return content
	const block = content[0] as { type?: unknown; text?: unknown }
	if (!block || block.type !== 'text' || typeof block.text !== 'string') return content
	const parsed = parseJson(block.text)
	const notice = {
		truncated: true,
		omitted_count: cappedStructured.omitted_count,
		notice: cappedStructured.notice,
		...(cappedStructured.omitted_ids ? { omitted_ids: cappedStructured.omitted_ids } : {}),
	}
	if (Array.isArray(parsed)) {
		const idField = target.idField ?? 'id'
		const dropped = new Set(extractIds(omittedRows, idField))
		const kept = parsed.filter((entry) => !dropped.has((entry as { id?: string } | null)?.id ?? ''))
		return [
			{ ...block, text: JSON.stringify(kept) },
			...content.slice(1),
			{ type: 'text', text: JSON.stringify(notice) },
		]
	}
	if (parsed && typeof parsed === 'object') {
		const { [target.rowsField]: _rows, ...rest } = parsed as Record<string, unknown>
		const rows = cappedStructured[target.rowsField] as unknown[]
		const page = rest.page
		const out: Record<string, unknown> = {
			...notice,
			...rest,
			...(page && typeof page === 'object'
				? { page: { ...(page as object), returned: rows.length, has_more: true } }
				: {}),
			...('next_cursor' in cappedStructured ? { next_cursor: cappedStructured.next_cursor } : {}),
			[target.rowsField]: rows,
		}
		return [{ ...block, text: JSON.stringify(out) }, ...content.slice(1)]
	}
	return content
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/**
 * Re-encode `structuredContent.next_cursor` (and `page.next_cursor`) to the
 * keyset of the last row the client can still recover in one hop — index
 * `recoverableCount - 1` in `omittedRows` when a `fetchHandleTool` exists, or
 * (when `recoverableCount` is 0, i.e. no get-by-id counterpart) the last row
 * still present in `keptRows`. Only fires when the pre-trim payload carried
 * a cursor AND `omittedRows.length > recoverableCount`; otherwise the
 * original cursor is either already null, or already points past every
 * omitted row so no rewrite is needed.
 *
 * Falls back to a no-op if the boundary row is missing `createdAt`/`id` or
 * if the inherited cursor can't be decoded — the original next_cursor is
 * kept so the client sees the same shape as before the fix.
 */
function rewriteNextCursor(
	structured: Record<string, unknown>,
	keptRows: unknown[],
	omittedRows: unknown[],
	recoverableCount: number,
): Record<string, unknown> {
	if (omittedRows.length <= recoverableCount) return structured
	const inherited = readCursor(structured)
	if (inherited === undefined) return structured
	const decoded = decodeCursor(inherited)
	if (!decoded) return structured
	const boundary = recoverableCount > 0 ? omittedRows[recoverableCount - 1] : keptRows.at(-1)
	if (!boundary || typeof boundary !== 'object') return structured
	const row = boundary as Record<string, unknown>
	const sortValue = row.createdAt
	const id = row.id
	if (typeof sortValue !== 'string' || typeof id !== 'string') return structured
	const rewritten = encodeCursor({
		s: decoded.s,
		o: decoded.o,
		k: { sortValue, id },
	})
	return writeCursor(structured, rewritten)
}

function resumeAfterKept(
	rsp: MutableMcpResponse,
	structured: Record<string, unknown>,
	keptRows: unknown[],
	idField: string,
): Record<string, unknown> {
	// The card names rows the trim dropped whether or not the tool can resume a cursor.
	const synced = syncHeroCardRows(structured, keptRows, idField)
	const resume = rsp[RESUME_CURSOR] as ResumeCursorFn | undefined
	if (typeof resume !== 'function') return synced
	const last = keptRows[keptRows.length - 1]
	if (last === undefined) return synced
	const cursor = resume(last)
	if (!cursor) return synced
	const out: Record<string, unknown> = { ...synced, next_cursor: cursor }
	const page = synced.page
	if (page && typeof page === 'object') out.page = { ...page, next_cursor: cursor }
	const heroCard = synced.heroCard as { page?: Record<string, unknown> } | undefined
	if (heroCard?.page) out.heroCard = { ...heroCard, page: { ...heroCard.page, hasMore: true } }
	return out
}

/**
 * The tool builds its heroCard before the cap runs, so it still names rows the
 * trim dropped. Keep only the card objects whose id ships in the rows array and
 * size the card page to match. The card's totalCount stays the real total.
 */
function syncHeroCardRows(
	structured: Record<string, unknown>,
	keptRows: unknown[],
	idField: string,
): Record<string, unknown> {
	const heroCard = structured.heroCard as
		| { objects?: Array<{ id?: unknown }>; page?: Record<string, unknown> }
		| undefined
	if (!heroCard || !Array.isArray(heroCard.objects)) return structured
	const keptIds = new Set(extractIds(keptRows, idField))
	const objects = heroCard.objects.filter((o) => typeof o?.id === 'string' && keptIds.has(o.id))
	const page = heroCard.page && { ...heroCard.page, limit: objects.length }
	return { ...structured, heroCard: { ...heroCard, objects, ...(page ? { page } : {}) } }
}

/**
 * Keep `page.returned` equal to the rows that actually ship. The tool wrote it
 * from the pre-trim page, so after a trim it would count rows the caller never
 * received. The omitted rows stay reachable through `_meta.fetch_handle` and the
 * cursor.
 */
function syncReturnedCount(
	structured: Record<string, unknown>,
	keptCount: number,
): Record<string, unknown> {
	const page = structured.page
	if (!page || typeof page !== 'object') return structured
	if (typeof (page as Record<string, unknown>).returned !== 'number') return structured
	return { ...structured, page: { ...(page as Record<string, unknown>), returned: keptCount } }
}

interface TruncationNotice {
	kept: number
	omitted: number
	target: TokenCapDescriptor
	fetchTool?: string
	omittedIds: string[]
}

/**
 * Say in the payload itself that rows were dropped. `_meta.truncated` is invisible to a client that
 * reads only the text (a live call), which then sees a short page with nothing to tell it so. The
 * rows that were cut are still reachable through the cursor or the fetch handle; `has_more` is set
 * so a page that looked like the last one does not. `notice` says in plain words what shipped and
 * how to ask for the rest.
 */
function markTruncated(
	structured: Record<string, unknown>,
	info: TruncationNotice,
): Record<string, unknown> {
	const page = structured.page
	const withPage =
		page &&
		typeof page === 'object' &&
		typeof (page as Record<string, unknown>).has_more === 'boolean'
			? { ...structured, page: { ...(page as Record<string, unknown>), has_more: true } }
			: structured
	return {
		...withPage,
		truncated: true,
		omitted_count: info.omitted,
		...(info.omittedIds.length > 0 ? { omitted_ids: info.omittedIds } : {}),
		notice: buildNotice(withPage, info),
	}
}

function buildNotice(structured: Record<string, unknown>, info: TruncationNotice): string {
	const { kept, omitted, target } = info
	const parts = [
		`Showing ${kept} of ${kept + omitted} ${target.rowsField}; the last ${omitted} were left out to keep the reply small.`,
	]
	if (info.omittedIds.length > 0) {
		parts.push(
			`Ask again with only the ids in omitted_ids${info.fetchTool ? ` (${info.fetchTool})` : ''}.`,
		)
	} else if (readCursor(structured)) {
		parts.push('Pass next_cursor to get the rest.')
	} else if (info.fetchTool) {
		parts.push(`Fetch them one by one with ${info.fetchTool} (ids in _meta.fetch_handle).`)
	}
	if (target.narrowHint) parts.push(target.narrowHint)
	return parts.join(' ')
}

function readCursor(structured: Record<string, unknown>): string | undefined {
	const top = structured.next_cursor
	if (typeof top === 'string' && top.length > 0) return top
	const page = structured.page
	if (page && typeof page === 'object') {
		const inPage = (page as Record<string, unknown>).next_cursor
		if (typeof inPage === 'string' && inPage.length > 0) return inPage
	}
	return undefined
}

function writeCursor(
	structured: Record<string, unknown>,
	nextCursor: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...structured }
	if (typeof structured.next_cursor === 'string') out.next_cursor = nextCursor
	const page = structured.page
	if (page && typeof page === 'object') {
		const pageObj = page as Record<string, unknown>
		if (typeof pageObj.next_cursor === 'string') {
			out.page = { ...pageObj, next_cursor: nextCursor }
		}
	}
	return out
}

function readPath(row: unknown, path: string): unknown {
	let cur: unknown = row
	for (const key of path.split('.')) {
		if (cur == null || typeof cur !== 'object') return undefined
		cur = (cur as Record<string, unknown>)[key]
	}
	return cur
}

function extractIds(rows: unknown[], idField: string): string[] {
	const ids: string[] = []
	for (const row of rows) {
		if (row == null || typeof row !== 'object') continue
		const value = readPath(row, idField)
		if (typeof value === 'string' && value.length > 0) ids.push(value)
	}
	return ids
}

/**
 * Estimate how many tokens the serialized response will consume on the
 * wire. Matches T1's telemetry accounting: sum `content` bytes and
 * `structuredContent` bytes independently (mirrors the two-channel wire
 * shape) and convert with `Math.ceil(bytes / 4)`. `_meta` is measured too
 * because the cap must include the fetch_handle payload it would add.
 *
 * Uses `Buffer.byteLength(JSON.stringify(...))` per channel so multi-byte
 * chars count correctly and a failed stringify (circular references) reads
 * as zero rather than crashing the tool call.
 */
export function estimateResponseTokens(response: unknown): number {
	if (response == null || typeof response !== 'object') return 0
	const r = response as { content?: unknown; structuredContent?: unknown; _meta?: unknown }
	return (
		estimateTokensFromBytes(measureJsonBytes(r.content)) +
		estimateTokensFromBytes(measureJsonBytes(r.structuredContent)) +
		estimateTokensFromBytes(measureJsonBytes(r._meta))
	)
}

function measureJsonBytes(value: unknown): number {
	if (value === undefined || value === null) return 0
	try {
		const json = JSON.stringify(value)
		return json ? Buffer.byteLength(json, 'utf8') : 0
	} catch {
		return 0
	}
}

// ─── One reply that is a single record, or a record with a long log array ─────────────────────
//
// `get_file`, `get_session` and `get_session_logs` return one JSON text block and no
// `structuredContent`, so the row cap above never saw them. They are the largest replies in the
// 12 to 19 Nov size data (1.2 to 2.2 MB). A cut keeps the shape of that JSON (the same keys, the
// same array of rows), says in the text what was cut and how to ask for the rest, and sets
// `_meta.truncated`.

export interface RecordCapDescriptor {
	/** Plain words on how to ask for less. */
	narrowHint: string
	/** Name of a long array inside the record (`logs` on get_session). The reply itself is the array when absent. */
	arrayField?: string
	/** What the rows are called in the notice. */
	rowsLabel?: string
	/** Plain words on how to read on after the last row shown (a log id to start from). */
	resumeHint?: (ctx: { lastRow: unknown; descending: boolean; record: unknown }) =>
		| string
		| undefined
	/** Plain words on how to read on after a cut text field (a character offset to start from). */
	continueHint?: (record: unknown, cuts: Cut[]) => string | undefined
}

function resumeFromLogId(ctx: { lastRow: unknown; descending: boolean; record: unknown }) {
	const id = (ctx.lastRow as { id?: unknown } | null)?.id
	if (typeof id !== 'number') return undefined
	const sessionId =
		(ctx.record as { session?: { id?: string }; id?: string } | null)?.session?.id ??
		(ctx.record as { id?: string } | null)?.id
	const call = sessionId ? `get_session_logs with id ${sessionId}` : 'get_session_logs'
	return ctx.descending
		? `Read older lines with ${call} and before_id ${id}.`
		: `Read later lines with ${call} and after_id ${id}.`
}

export const RECORD_CAP_TARGETS: Record<string, RecordCapDescriptor> = {
	get_file: {
		narrowHint:
			'For an HTML page, pass format "text" to read only its words instead of its markup.',
		continueHint: (record, cuts) => {
			const cut = cuts.find((c) => c.path === 'content' || c.path === 'content_text')
			if (!cut) return undefined
			const start = (record as { offset?: unknown } | null)?.offset
			const next = (typeof start === 'number' ? start : 0) + cut.shown
			return `To read on, call get_file again with offset ${next}.`
		},
	},
	get_session: {
		arrayField: 'logs',
		rowsLabel: 'log lines',
		resumeHint: resumeFromLogId,
		narrowHint: 'Ask for a smaller log_limit, or page the logs with get_session_logs.',
	},
	get_session_logs: {
		rowsLabel: 'log lines',
		resumeHint: resumeFromLogId,
		narrowHint: 'Ask for a smaller limit, or filter to one stream.',
	},
}

export interface Cut {
	path: string
	shown: number
	total: number
}

const MIN_KEPT_CHARS = 200
/** Share of the cap that text outside the log lines may take before it is cut. */
const FIXED_PART_SHARE = 0.6
/** Room left under the cap for the notice a cut adds. */
const NOTICE_RESERVE_TOKENS = 150

interface StringLeaf {
	holder: Record<string, unknown>
	key: string
	path: string
	head: string
	kept: number
}

function collectStringLeaves(
	node: unknown,
	path: string,
	out: StringLeaf[],
	depth = 0,
): StringLeaf[] {
	if (depth > 8 || node == null || typeof node !== 'object') return out
	for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
		const childPath = path ? `${path}.${key}` : key
		if (typeof child === 'string') {
			if (child.length > MIN_KEPT_CHARS) {
				out.push({
					holder: node as Record<string, unknown>,
					key,
					path: childPath,
					head: child,
					kept: child.length,
				})
			}
		} else {
			collectStringLeaves(child, childPath, out, depth + 1)
		}
	}
	return out
}

/**
 * Cut the long strings in a copy of `input` until `overBy` (tokens above the cap) is zero or less.
 * Every string longer than one shared limit is cut to that limit, and the limit is the highest one
 * that fits, so two copies of the same text (the text and structured channels) lose the same amount.
 * A cut string keeps its head and ends with a marker that says how much was left out. When even the
 * lowest limit does not fit, the caller ships what is left.
 */
function shrinkLongStrings<T>(input: T, overBy: (value: T) => number): { value: T; cuts: Cut[] } {
	const value = structuredClone(input)
	const leaves = collectStringLeaves(value, '', [])
	const apply = (limit: number) => {
		for (const leaf of leaves) {
			let keep = Math.min(leaf.head.length, limit)
			const last = leaf.head.charCodeAt(keep - 1)
			if (keep < leaf.head.length && last >= 0xd800 && last <= 0xdbff) keep--
			leaf.kept = keep
			leaf.holder[leaf.key] =
				keep >= leaf.head.length
					? leaf.head
					: `${leaf.head.slice(0, keep)}… [${leaf.head.length - keep} more characters cut]`
		}
	}
	const longest = leaves.reduce((max, leaf) => Math.max(max, leaf.head.length), 0)
	let lo = MIN_KEPT_CHARS
	let hi = longest
	apply(lo)
	if (overBy(value) <= 0) {
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2)
			apply(mid)
			if (overBy(value) <= 0) lo = mid
			else hi = mid - 1
		}
		apply(lo)
	}
	const cuts = leaves
		.filter((l) => l.kept < l.head.length)
		.map((l) => ({ path: l.path, shown: l.kept, total: l.head.length }))
	return { value, cuts }
}

function describeCuts(cuts: Cut[]): string {
	const shown = cuts.slice(0, 5).map((c) => `${c.path} (${c.shown} of ${c.total} characters)`)
	const more = cuts.length > 5 ? ` and ${cuts.length - 5} more` : ''
	return `Long text was cut: ${shown.join(', ')}${more}.`
}

function firstTextBlock(content: unknown): { index: number; text: string } | undefined {
	if (!Array.isArray(content)) return undefined
	const index = content.findIndex(
		(b) =>
			b &&
			typeof b === 'object' &&
			(b as { type?: unknown }).type === 'text' &&
			typeof (b as { text?: unknown }).text === 'string',
	)
	return index < 0 ? undefined : { index, text: (content[index] as { text: string }).text }
}

function applyRecordTokenCap(
	target: RecordCapDescriptor,
	response: unknown,
	opts?: { maxTokens?: number; env?: NodeJS.ProcessEnv | Record<string, string | undefined> },
): ApplyResponseTokenCapResult {
	if (response == null || typeof response !== 'object') return { response, truncated: false }
	const rsp = response as MutableMcpResponse
	const block = firstTextBlock(rsp.content)
	if (!block) return { response, truncated: false }
	const maxTokens = opts?.maxTokens ?? getMaxResponseTokens(opts?.env)
	if (estimateResponseTokens(response) <= maxTokens) return { response, truncated: false }
	const parsed = parseJson(block.text)
	if (parsed == null || typeof parsed !== 'object') return { response, truncated: false }

	const isArray = Array.isArray(parsed)
	const allRows = isArray
		? (parsed as unknown[])
		: target.arrayField
			? ((parsed as Record<string, unknown>)[target.arrayField] as unknown)
			: undefined
	const rows = Array.isArray(allRows) ? allRows : undefined

	// What the reply looks like with `keep` rows and a notice in it.
	const assemble = (record: unknown, keep: number | undefined, notice: string | undefined) => {
		let body: unknown = record
		if (rows && keep !== undefined) {
			const kept = (
				isArray
					? (record as unknown[])
					: ((record as Record<string, unknown>)[target.arrayField as string] as unknown[])
			).slice(0, keep)
			body = isArray ? kept : { ...(record as object), [target.arrayField as string]: kept }
		}
		const flagged =
			!isArray && notice ? { truncated: true, notice, ...(body as Record<string, unknown>) } : body
		const content = [...(rsp.content as unknown[])]
		content[block.index] = { ...(content[block.index] as object), text: JSON.stringify(flagged) }
		if (isArray && notice)
			content.push({ type: 'text', text: JSON.stringify({ truncated: true, notice }) })
		return {
			...rsp,
			content,
			_meta: { ...(rsp._meta ?? {}), truncated: true },
		} as MutableMcpResponse
	}
	const tokens = (r: MutableMcpResponse) => estimateResponseTokens(r)

	// 0. Long text outside the rows (a prompt, a config) must not push every row out. Cut it first,
	//    down to the share of the cap it may take, then fit the rows into what is left.
	const withRows = (rec: unknown, list: unknown[]) =>
		isArray ? list : { ...(rec as object), [target.arrayField as string]: list }
	const reserve = 'x'.repeat(NOTICE_RESERVE_TOKENS * 4)
	let base: unknown = parsed
	let cuts: Cut[] = []
	if (rows) {
		const fixedBudget = Math.floor(maxTokens * FIXED_PART_SHARE)
		const fixed = withRows(parsed, [])
		if (tokens(assemble(fixed, undefined, reserve)) > fixedBudget) {
			const shrunk = shrinkLongStrings(
				fixed,
				(v) => tokens(assemble(v, undefined, reserve)) - fixedBudget,
			)
			base = withRows(shrunk.value, rows)
			cuts = shrunk.cuts
		}
	}

	// 1. Drop log lines from the tail, never below one. Binary search: each probe is a full serialize.
	const baseRows = rows
		? isArray
			? (base as unknown[])
			: ((base as Record<string, unknown>)[target.arrayField as string] as unknown[])
		: undefined
	let keep: number | undefined
	if (rows && rows.length > 1) {
		let lo = 1
		let hi = rows.length
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2)
			if (tokens(assemble(base, mid, reserve)) <= maxTokens) lo = mid
			else hi = mid - 1
		}
		keep = lo < rows.length ? lo : undefined
	}
	let record: unknown = base
	if (baseRows && keep !== undefined) record = withRows(base, baseRows.slice(0, keep))

	// 2. A record still over the cap (one huge line, a long prompt, file text) has its longest strings cut.
	if (tokens(assemble(record, undefined, reserve)) > maxTokens) {
		const shrunk = shrinkLongStrings(
			record,
			(v) => tokens(assemble(v, undefined, reserve)) - maxTokens,
		)
		record = shrunk.value
		cuts = [...cuts, ...shrunk.cuts]
	}
	if (keep === undefined && cuts.length === 0) return { response, truncated: false }

	const notes: string[] = []
	if (rows && keep !== undefined) {
		const lastRow = rows[keep - 1]
		const descending =
			rows.length > 1
				? Number((rows[0] as { id?: unknown })?.id) > Number((rows[1] as { id?: unknown })?.id)
				: true
		notes.push(
			`Showing ${keep} of ${rows.length} ${target.rowsLabel ?? 'rows'}; the last ${rows.length - keep} were left out to keep the reply small.`,
		)
		const resume = target.resumeHint?.({ lastRow, descending, record: parsed })
		if (resume) notes.push(resume)
	}
	if (cuts.length > 0) {
		notes.push(describeCuts(cuts))
		const next = target.continueHint?.(record, cuts)
		if (next) notes.push(next)
	}
	notes.push(target.narrowHint)
	return { response: assemble(record, undefined, notes.join(' ')), truncated: true }
}

/**
 * A lone row that is still over the cap after every other row was dropped: cut its longest text
 * (an object body, a comment) in both channels and say so in the payload. Returns null when no
 * string is long enough to cut.
 */
function cutOversizedRow(
	response: MutableMcpResponse,
	maxTokens: number,
): MutableMcpResponse | null {
	const block = firstTextBlock(response.content)
	const textValue = block ? parseJson(block.text) : undefined
	const textIsJson = textValue !== undefined
	const bundle = { s: response.structuredContent, t: textIsJson ? textValue : block?.text }
	const assemble = (b: typeof bundle): MutableMcpResponse => {
		const content = Array.isArray(response.content) ? [...response.content] : response.content
		if (block && Array.isArray(content)) {
			content[block.index] = {
				...(content[block.index] as object),
				text: textIsJson ? JSON.stringify(b.t) : (b.t as string),
			}
		}
		return { ...response, content, structuredContent: b.s as Record<string, unknown> }
	}
	const budget = Math.max(1, maxTokens - NOTICE_RESERVE_TOKENS)
	const { value, cuts } = shrinkLongStrings(
		bundle,
		(b) => estimateResponseTokens(assemble(b)) - budget,
	)
	if (cuts.length === 0) return null
	const fromStructured = cuts.filter((c) => c.path.startsWith('s.'))
	const shown = describeCuts(
		(fromStructured.length > 0 ? fromStructured : cuts).map((c) => ({
			...c,
			path: c.path.replace(/^(s|t)\./, ''),
		})),
	)
	const structured = value.s as Record<string, unknown>
	const earlier = typeof structured?.notice === 'string' ? structured.notice : undefined
	const notice = `${earlier ? `${earlier} ` : ''}${shown} Ask for less of this record (for example without the events or long text blocks).`
	value.s = { ...structured, truncated: true, notice }
	// The text copy carries the same notice (inside the object, or in the extra block after an
	// array), so a client that reads only the text sees what was cut as well.
	const sync = (v: unknown) => {
		if (
			v &&
			typeof v === 'object' &&
			!Array.isArray(v) &&
			(v as { notice?: unknown }).notice === earlier
		) {
			;(v as { notice?: string }).notice = notice
		}
	}
	if (earlier) sync(value.t)
	const out = assemble(value)
	if (earlier && Array.isArray(out.content)) {
		out.content = out.content.map((b, i) => {
			if (
				i === 0 ||
				!b ||
				typeof b !== 'object' ||
				typeof (b as { text?: unknown }).text !== 'string'
			)
				return b
			const parsed = parseJson((b as { text: string }).text)
			if (
				!parsed ||
				typeof parsed !== 'object' ||
				(parsed as { notice?: unknown }).notice !== earlier
			)
				return b
			return { ...(b as object), text: JSON.stringify({ ...(parsed as object), notice }) }
		})
	}
	return out
}
