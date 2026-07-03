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
//
// `list_actors` / `list_triggers` are omitted deliberately: their
// `structuredContent` only carries the 25-item heroCard slice — the rich
// rows never reach the structured channel, so there is nothing for the cap
// to trim. `list_relationships` is omitted because no `get_relationship`
// tool exists; its rows are lightweight enough that overflow is not a
// realistic path.

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
 * `fetch_handle.ids` upper bound. Matches the tightest schema constraint
 * across get-by-id counterparts — `get_objects` accepts up to 50 ids per
 * call. Anything larger would produce a fetch_handle the client can't act on
 * in one hop. Kept in step with the schema at
 * `packages/mcp/src/tools.ts` — bumping one side without the other regresses
 * AC-T6 silently.
 */
export const MAX_FETCH_HANDLE_IDS = 50

/**
 * Registry of tools whose `structuredContent` carries a rich row array and
 * for which a get-by-id counterpart exists. `rowsField` is the key in
 * `structuredContent` that holds the array. `idField` is the property on
 * each row whose value becomes an entry in `fetch_handle.ids` (default
 * `id`; `list_workspace_skills` uses `name`).
 */
export interface TokenCapDescriptor {
	fetchHandleTool: string
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
	/** IDs of the omitted rows (or `undefined` when no trim happened). */
	omittedIds?: string[]
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
			ids: extractIds(omitted, idField),
		})
		if (estimateResponseTokens(candidate) <= maxTokens) {
			return {
				response: candidate,
				truncated: true,
				omittedIds: extractIds(omitted, idField),
			}
		}
	}

	// Even zero rows doesn't fit under the cap. Return the empty-rows shape
	// with a fetch_handle listing every original row's id — the caller can
	// still recover the payload via the get-by-id tool.
	const finalResponse = buildCappedResponse(rsp, structured, target.rowsField, [], {
		tool: target.fetchHandleTool,
		ids: extractIds(rowsRaw as unknown[], idField),
	})
	return {
		response: finalResponse,
		truncated: true,
		omittedIds: extractIds(rowsRaw as unknown[], idField),
	}
}

function buildCappedResponse(
	rsp: MutableMcpResponse,
	structured: Record<string, unknown>,
	rowsField: string,
	keptRows: unknown[],
	fetchHandle: FetchHandle,
): MutableMcpResponse {
	// Cap the fetch_handle.ids at MAX_FETCH_HANDLE_IDS so a single hop of
	// `fetch_handle.tool(ids)` stays within the get-by-id schema's cap.
	const cappedIds = fetchHandle.ids.slice(0, MAX_FETCH_HANDLE_IDS)
	const meta = {
		...(rsp._meta ?? {}),
		truncated: true,
		fetch_handle: {
			tool: fetchHandle.tool,
			ids: cappedIds,
		},
	}
	return {
		...rsp,
		structuredContent: { ...structured, [rowsField]: keptRows },
		_meta: meta,
	}
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
