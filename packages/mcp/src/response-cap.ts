// MCP response token cap — the last guardrail before a tool response ships.
//
// When the fully-serialized response would push a client (Claude Code caps
// tool results at 25,000 tokens) over budget, this wrapper drops complete
// rows from the tail of `structuredContent`, populates
// `_meta.truncated = true` and `_meta.fetch_handle = { tool, ids }`, and
// leaves it to the caller to re-fetch the omitted rows via the get-by-id
// counterpart. Fires only under `MCP_RESPONSE_SCOPING`; flag-off is byte-
// identical to the pre-scoping response.
//
// Reuses T1's `bytes/4` token estimator so the cap check and the response-
// size telemetry event count tokens the same way — otherwise the wrapper
// could clear the gate while telemetry reports over-budget (or vice versa).
//
// Row-carrying tools registered here:
//
//   list_objects        → get_objects (batch, `ids`)
//   search_objects      → get_objects (batch, `ids`)
//   list_files          → get_file    (single, `id`)
//   list_workspace_skills → get_workspace_skill (single, `name`)
//   list_relationships  → no get-by-id counterpart — see below
//
// `list_actors` / `list_triggers` are omitted deliberately: their
// `structuredContent` only carries the 25-item heroCard slice — the rich
// rows never reach the structured channel, so there is nothing for the cap
// to trim.
//
// `list_relationships` IS registered despite having no `get_relationship`
// tool: its rows carry unbounded `sourceTitle`/`targetTitle` strings (joined
// from `objects.title`, which has no length cap), so overflow is a real
// path. With no `fetchHandleTool`, trimmed rows have no one-hop recovery —
// instead `rewriteNextCursor` below always redirects `next_cursor` to point
// right after the last row still present in `structuredContent`, so a
// follow-up call with that cursor returns exactly the trimmed tail next
// (an extra round trip, but no permanently unrecoverable rows).

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
	idField?: string
}

export const TOKEN_CAP_TARGETS: Record<string, TokenCapDescriptor> = {
	list_objects: { fetchHandleTool: 'get_objects', rowsField: 'objects' },
	search_objects: { fetchHandleTool: 'get_objects', rowsField: 'objects' },
	list_files: { fetchHandleTool: 'get_file', rowsField: 'files' },
	list_workspace_skills: {
		fetchHandleTool: 'get_workspace_skill',
		rowsField: 'skills',
		idField: 'name',
	},
	list_relationships: { rowsField: 'relationships' },
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

interface MutableMcpResponse {
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
 * re-measure. As soon as we drop under the cap, return. If even zero rows
 * doesn't fit (large `_meta`, huge `content`), we still return the empty-
 * rows response so the caller sees `_meta.truncated=true` and can fall back
 * to the fetch_handle.
 *
 * The response argument is not mutated — we build a shallow copy of
 * `structuredContent` and `_meta` on every trim so callers holding a
 * reference to the original see nothing change.
 */
export function applyResponseTokenCap(
	toolName: string,
	response: unknown,
	opts?: { maxTokens?: number; env?: NodeJS.ProcessEnv | Record<string, string | undefined> },
): ApplyResponseTokenCapResult {
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

	// Drop from the tail until we fit or run out of rows. The while-loop is
	// bounded by `rows.length` — no risk of runaway iteration even if the
	// estimator is flaky.
	while (rows.length > 0) {
		const dropped = rows.pop()
		omitted.unshift(dropped)
		const candidate = buildCappedResponse(rsp, structured, target.rowsField, rows, {
			tool: target.fetchHandleTool,
			ids: target.fetchHandleTool ? extractIds(omitted, idField) : [],
			omittedRows: omitted,
		})
		if (estimateResponseTokens(candidate) <= maxTokens) {
			return { response: candidate, truncated: true }
		}
	}

	// Even zero rows doesn't fit under the cap. Return the empty-rows shape
	// with a fetch_handle listing every original row's id (when a get-by-id
	// counterpart exists) — the caller can still recover the payload via the
	// get-by-id tool, or via the rewritten cursor otherwise.
	const finalResponse = buildCappedResponse(rsp, structured, target.rowsField, [], {
		tool: target.fetchHandleTool,
		ids: target.fetchHandleTool ? extractIds(rowsRaw as unknown[], idField) : [],
		omittedRows: rowsRaw as unknown[],
	})
	return { response: finalResponse, truncated: true }
}

interface TrimResult {
	tool?: string
	ids: string[]
	omittedRows: unknown[]
}

function buildCappedResponse(
	rsp: MutableMcpResponse,
	structured: Record<string, unknown>,
	rowsField: string,
	keptRows: unknown[],
	fetchHandle: TrimResult,
): MutableMcpResponse {
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
	const cappedStructured = rewriteNextCursor(
		{ ...structured, [rowsField]: keptRows },
		keptRows,
		fetchHandle.omittedRows,
		fetchHandle.tool ? cappedIds.length : 0,
	)
	return {
		...rsp,
		structuredContent: cappedStructured,
		_meta: meta,
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

function extractIds(rows: unknown[], idField: string): string[] {
	const ids: string[] = []
	for (const row of rows) {
		if (row == null || typeof row !== 'object') continue
		const value = (row as Record<string, unknown>)[idField]
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
