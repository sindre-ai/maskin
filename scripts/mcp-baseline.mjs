#!/usr/bin/env node
/**
 * Repeatable, read-only baseline of the Maskin MCP surface.
 *
 * Every later MCP phase re-runs this and compares the numbers, so "it worked" is provable.
 * Spec: the MCP leftovers tech spec (rev 2.1), section 1.
 *
 *   MASKIN_API_KEY=... MASKIN_WORKSPACE_ID=... node scripts/mcp-baseline.mjs [--json]
 *
 * Env: MASKIN_MCP_URL (default https://maskin.io/mcp), MASKIN_API_KEY, MASKIN_WORKSPACE_ID,
 * MASKIN_BASELINE_ACTOR_IDS (optional comma list of actor ids to pin get_actor to),
 * MASKIN_BASELINE_KEY_ACTOR_TYPE (optional human|agent; MCP does not tell a caller what it is).
 *
 * Safety: only the allowlisted read tools below can be called (assertReadOnly), response bodies
 * are measured and dropped (never printed or stored), and the API key is never echoed.
 * Exit codes: 0 ok, 1 any failure, 2 a write tool was about to be called.
 *
 * Node 20, no dependencies. Pure functions are exported for tests; main runs only when the file
 * is invoked directly.
 */

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const DEFAULT_MCP_URL = 'https://maskin.io/mcp'

/** The only names callTool will send. tools/list is a method, kept here so the guard is one list. */
export const READ_ONLY_ALLOWLIST = [
	'tools/list',
	'list_workspaces',
	'list_actors',
	'get_actor',
	'list_sessions',
	'get_events',
	'get_workspace_schema',
]

const TOOLS_USED = READ_ONLY_ALLOWLIST.filter((n) => n !== 'tools/list')

/** Figures from the 12 Oct 2026 audit. Copied, not measured by this script. */
export const AUDIT = {
	tool_count: 65,
	tools_list_bytes: 130_000,
	tools_list_tokens: 34_000,
	list_workspaces_bytes: 88_000,
	list_workspaces_rows: 12,
	list_actors_bytes: 24_000,
	events_reachable: 100,
}

const EVENT_LIMITS = [3, 10, 25, 50, 100]
const EVENT_PAGE_CAP = 50
const DESCRIPTION_LIMIT = 2048
const MAX_RETRY_AFTER_SECONDS = 120

export class ReadOnlyViolation extends Error {
	constructor(name) {
		super(`Refusing to call "${name}": not on the read-only allowlist`)
		this.name = 'ReadOnlyViolation'
	}
}

export function assertReadOnly(name) {
	if (!READ_ONLY_ALLOWLIST.includes(name)) throw new ReadOnlyViolation(name)
}

export function exitCodeFor(err) {
	return err instanceof ReadOnlyViolation ? 2 : 1
}

/** Strip the key from any text that might reach stdout or stderr. */
export function redact(text, secret) {
	const s = String(text)
	return secret ? s.split(secret).join('[redacted]') : s
}

// ---------------------------------------------------------------------------------------------
// Measuring (pure)
// ---------------------------------------------------------------------------------------------

export function jsonBytes(value) {
	return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function contentTexts(result) {
	return Array.isArray(result?.content)
		? result.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text)
		: []
}

export function contentBytes(result) {
	return contentTexts(result).reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0)
}

export function structuredBytes(result) {
	return result?.structuredContent === undefined ? 0 : jsonBytes(result.structuredContent)
}

/** Size of the heroCard key of content[0].text parsed as JSON; 0 when absent or not JSON. */
export function heroCardBytes(result) {
	const first = contentTexts(result)[0]
	if (first === undefined) return 0
	try {
		const parsed = JSON.parse(first)
		return parsed && typeof parsed === 'object' && 'heroCard' in parsed
			? jsonBytes(parsed.heroCard)
			: 0
	} catch {
		return 0
	}
}

export function measureCall(result) {
	return {
		is_error: result?.isError === true,
		content_bytes: contentBytes(result),
		structured_bytes: structuredBytes(result),
		hero_card_bytes: heroCardBytes(result),
	}
}

/** Rows of a list result, wherever the tool put them. */
export function extractRows(result, key) {
	const sc = result?.structuredContent
	if (Array.isArray(sc?.[key])) return sc[key]
	const hero = sc?.heroCard
	if (Array.isArray(hero?.objects)) return hero.objects
	if (hero?.object && typeof hero.object === 'object') return [hero.object]
	const first = contentTexts(result)[0]
	if (first !== undefined) {
		try {
			const parsed = JSON.parse(first)
			if (Array.isArray(parsed)) return parsed
			if (Array.isArray(parsed?.[key])) return parsed[key]
		} catch {
			// not JSON: no rows
		}
	}
	return []
}

export function nextCursorOf(result) {
	const sc = result?.structuredContent
	const cursor = sc?.next_cursor ?? sc?.page?.next_cursor
	if (typeof cursor === 'string' && cursor) return cursor
	const first = contentTexts(result)[0]
	if (first !== undefined) {
		try {
			const c = JSON.parse(first)?.next_cursor
			if (typeof c === 'string' && c) return c
		} catch {
			// not JSON
		}
	}
	return null
}

export function summarizeToolsList(listResult) {
	const tools = Array.isArray(listResult?.tools) ? listResult.tools : []
	const sizes = tools
		.map((t) => ({ name: String(t.name), chars: String(t.description ?? '').length }))
		.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
	const bytes = jsonBytes(listResult)
	const notReadOnly = tools
		.filter(
			(t) =>
				READ_ONLY_ALLOWLIST.includes(t.name) &&
				t.annotations &&
				t.annotations.readOnlyHint === false,
		)
		.map((t) => t.name)
		.sort()
	return {
		tool_count: tools.length,
		bytes,
		tokens_estimate: Math.ceil(JSON.stringify(listResult ?? {}).length / 4),
		with_title: tools.filter((t) => typeof t.title === 'string' && t.title).length,
		with_annotations: tools.filter((t) => t.annotations && typeof t.annotations === 'object')
			.length,
		with_output_schema: tools.filter((t) => t.outputSchema && typeof t.outputSchema === 'object')
			.length,
		descriptions_over_limit: sizes.filter((s) => s.chars > DESCRIPTION_LIMIT).length,
		top_description_sizes: sizes.slice(0, 5),
		allowlisted_not_read_only: notReadOnly,
		names: tools.map((t) => String(t.name)),
	}
}

/**
 * get_workspace_schema asked for an id that does not exist.
 * errors-and-names-the-id: isError true and the text mentions the id (correct).
 * returns-another-workspace: no error, so a schema for some other workspace came back (the bug).
 * other: anything else (an error that does not name the id).
 */
export function classifySchemaProbe(result, requestedId) {
	const mentionsId = contentTexts(result).some((t) => t.includes(requestedId))
	if (result?.isError === true) return mentionsId ? 'errors-and-names-the-id' : 'other'
	return 'returns-another-workspace'
}

/**
 * Walk get_events: one call per limit, then follow next_cursor from a limit 100 page.
 * `fetchPage({limit, cursor})` returns a tool result.
 */
export async function walkEvents(fetchPage, { pageCap = EVENT_PAGE_CAP } = {}) {
	const byLimit = {}
	const ids = new Set()
	let firstCursor = null
	for (const limit of EVENT_LIMITS) {
		const result = await fetchPage({ limit })
		const rows = extractRows(result, 'events')
		const cursor = nextCursorOf(result)
		byLimit[limit] = { rows: rows.length, has_cursor: cursor !== null, ...measureCall(result) }
		if (limit === EVENT_LIMITS[EVENT_LIMITS.length - 1]) {
			for (const r of rows) if (r?.id !== undefined) ids.add(r.id)
			firstCursor = cursor
		}
	}
	let pages = 1
	let cursor = firstCursor
	let stoppedBy = cursor === null ? 'end' : 'page_cap'
	const seenCursors = new Set()
	while (cursor !== null) {
		if (pages >= pageCap) {
			stoppedBy = 'page_cap'
			break
		}
		if (seenCursors.has(cursor)) {
			stoppedBy = 'repeated_cursor'
			break
		}
		seenCursors.add(cursor)
		const result = await fetchPage({ limit: 100, cursor })
		pages += 1
		for (const r of extractRows(result, 'events')) if (r?.id !== undefined) ids.add(r.id)
		cursor = nextCursorOf(result)
		if (cursor === null) stoppedBy = 'end'
	}
	return { by_limit: byLimit, pages, distinct_event_ids: ids.size, stopped_by: stoppedBy }
}

/** Pick the actors to call get_actor on. Pinned ids win; otherwise 3 with a description + 1 without. */
export function chooseActors(rows, pinnedIds) {
	if (pinnedIds.length > 0) return { ids: pinnedIds, pinned: true }
	const described = rows.filter((r) => typeof r.description === 'string' && r.description.trim())
	const bare = rows.filter((r) => !(typeof r.description === 'string' && r.description.trim()))
	const ids = [...described.slice(0, 3), ...bare.slice(0, 1)].map((r) => r.id)
	return { ids, pinned: false }
}

// ---------------------------------------------------------------------------------------------
// Report formatting (pure)
// ---------------------------------------------------------------------------------------------

/** Stable JSON: the report is built in a fixed key order, so equal runs print equal text. */
export function formatJson(report) {
	return `${JSON.stringify(report, null, 2)}\n`
}

function delta(audit, now) {
	if (typeof audit !== 'number' || typeof now !== 'number') return ''
	const d = now - audit
	return `${d > 0 ? '+' : ''}${d}`
}

export function formatTable(report) {
	const rows = []
	const add = (measure, audit, now) =>
		rows.push([measure, audit === undefined ? '-' : String(audit), String(now), delta(audit, now)])
	const t = report.tools_list
	const c = report.calls
	const w = report.workspaces
	add('tools (count)', AUDIT.tool_count, t.tool_count)
	add('tools/list bytes', AUDIT.tools_list_bytes, t.bytes)
	add('tools/list tokens (chars/4)', AUDIT.tools_list_tokens, t.tokens_estimate)
	add('tools with title', 0, t.with_title)
	add('tools with annotations', 0, t.with_annotations)
	add('tools with outputSchema', 0, t.with_output_schema)
	add('descriptions over 2,048 chars', 1, t.descriptions_over_limit)
	for (const [i, s] of t.top_description_sizes.entries())
		add(`top description ${i + 1}: ${s.name}`, undefined, s.chars)
	add('workspaces (count)', AUDIT.list_workspaces_rows, w.count)
	add('list_workspaces bytes (content+structured)', AUDIT.list_workspaces_bytes, w.bytes)
	add(
		'list_workspaces bytes per row',
		Math.round(AUDIT.list_workspaces_bytes / AUDIT.list_workspaces_rows),
		w.bytes_per_row,
	)
	for (const [name, m] of Object.entries(c)) {
		const audit = name === 'list_actors' ? AUDIT.list_actors_bytes : undefined
		add(`${name} content bytes`, undefined, m.content_bytes)
		add(`${name} structured bytes`, audit, m.structured_bytes)
		add(`${name} heroCard bytes`, undefined, m.hero_card_bytes)
	}
	for (const [limit, m] of Object.entries(report.events_walk.by_limit)) {
		add(`get_events limit ${limit}: rows`, limit === '100' ? 99 : Number(limit), m.rows)
		rows.push([
			`get_events limit ${limit}: cursor returned`,
			limit === '100' ? 'yes' : 'no',
			m.has_cursor ? 'yes' : 'no',
			'',
		])
	}
	add(
		'get_events reachable distinct ids',
		AUDIT.events_reachable,
		report.events_walk.distinct_event_ids,
	)
	rows.push(['get_events walk pages', '-', String(report.events_walk.pages), ''])
	rows.push(['get_events walk stopped by', '-', report.events_walk.stopped_by, ''])
	rows.push([
		'get_workspace_schema unknown id',
		'returns-another-workspace',
		report.schema_probe,
		'',
	])
	const head = ['measure', 'audit 12 Oct (copied)', 'now', 'delta']
	const all = [head, ...rows]
	const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)))
	const line = (r) =>
		r
			.map((cell, i) => cell.padEnd(widths[i]))
			.join('  ')
			.trimEnd()
	const m = report.meta
	const lines = [
		`MCP baseline for ${m.url}`,
		`key: ${m.key_actor_type}, ${m.workspaces_visible} workspace(s) visible; actors ${m.actors_pinned ? 'pinned' : 'UNPINNED'}; rate_limited: ${m.rate_limited}`,
		`server: ${m.server_name ?? 'unreported'} ${m.server_version ?? ''}`.trimEnd(),
		'',
		line(head),
		line(widths.map((n) => '-'.repeat(n))),
		...rows.map(line),
	]
	if (report.warnings.length > 0) lines.push('', ...report.warnings.map((x) => `warning: ${x}`))
	lines.push('', `took ${report.timing.duration_ms} ms at ${report.timing.started_at}`)
	if (m.workspaces_visible !== AUDIT.list_workspaces_rows) {
		lines.push(
			`note: this key sees ${m.workspaces_visible} workspace(s), the audit account saw ${AUDIT.list_workspaces_rows}; compare bytes per row, not totals.`,
		)
	}
	return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export function loadConfig(env) {
	const apiKey = env.MASKIN_API_KEY
	const workspaceId = env.MASKIN_WORKSPACE_ID
	if (!apiKey) throw new Error('MASKIN_API_KEY is not set')
	if (!workspaceId) throw new Error('MASKIN_WORKSPACE_ID is not set')
	const type = (env.MASKIN_BASELINE_KEY_ACTOR_TYPE ?? '').trim().toLowerCase()
	return {
		url: env.MASKIN_MCP_URL || DEFAULT_MCP_URL,
		apiKey,
		workspaceId,
		actorIds: (env.MASKIN_BASELINE_ACTOR_IDS ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		keyActorType: type === 'human' || type === 'agent' ? type : 'unknown',
	}
}

function parseRpcBody(text, contentType) {
	let payload = text
	if (contentType.includes('text/event-stream')) {
		const data = text
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim())
			.filter(Boolean)
		payload = data[data.length - 1] ?? ''
	}
	return JSON.parse(payload)
}

/**
 * Minimal JSON-RPC client over POST. Errors never carry a response body, only status and codes.
 * `state.rateLimited` is set when a 429 was waited out and retried.
 */
export function createClient(config, { fetchImpl = globalThis.fetch, sleep = defaultSleep } = {}) {
	const state = { rateLimited: false }
	let nextId = 1

	async function post(method, params) {
		const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
		const headers = {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${config.apiKey}`,
			'x-workspace-id': config.workspaceId,
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await fetchImpl(config.url, { method: 'POST', headers, body })
			if (res.status === 429) {
				const header = res.headers.get('retry-after')
				const seconds = header === null || header.trim() === '' ? Number.NaN : Number(header)
				const wait = Number.isFinite(seconds)
					? Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS)
					: 1
				await res.text()
				if (attempt === 1) throw new Error(`HTTP 429 on ${method} again after waiting ${wait}s`)
				state.rateLimited = true
				await sleep(wait * 1000)
				continue
			}
			const text = await res.text()
			if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`)
			let parsed
			try {
				parsed = parseRpcBody(text, res.headers.get('content-type') ?? '')
			} catch {
				throw new Error(`Response to ${method} was not JSON (HTTP ${res.status})`)
			}
			if (parsed.error) throw new Error(`JSON-RPC error ${parsed.error.code} on ${method}`)
			return parsed.result
		}
		throw new Error(`No response to ${method}`)
	}

	return {
		state,
		initialize: () =>
			post('initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'maskin-mcp-baseline', version: '1' },
			}),
		listTools: () => {
			assertReadOnly('tools/list')
			return post('tools/list', {})
		},
		callTool: (name, args = {}) => {
			assertReadOnly(name)
			return post('tools/call', { name, arguments: args })
		},
	}
}

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

export async function runBaseline(config, deps = {}) {
	const now = deps.now ?? (() => Date.now())
	const started = now()
	const client = createClient(config, deps)
	const ws = { workspace_id: config.workspaceId }
	const warnings = []

	const init = await client.initialize()
	const listed = await client.listTools()
	const tools = summarizeToolsList(listed)
	const missing = TOOLS_USED.filter((n) => !tools.names.includes(n))
	if (missing.length > 0) {
		throw new Error(`Allowlisted tool(s) missing from tools/list: ${missing.join(', ')}`)
	}
	for (const name of tools.allowlisted_not_read_only) {
		warnings.push(`${name} is on the allowlist but its readOnlyHint is false`)
	}

	const calls = {}
	const record = async (label, name, args) => {
		const result = await client.callTool(name, args)
		calls[label] = measureCall(result)
		return result
	}

	const wsDefault = await record('list_workspaces', 'list_workspaces', {})
	await record('list_workspaces_limit_1', 'list_workspaces', { limit: 1 })
	const wsRows = extractRows(wsDefault, 'workspaces')
	const wsTotal = wsDefault?.structuredContent?.page?.total
	const wsCount = typeof wsTotal === 'number' ? wsTotal : wsRows.length
	const wsBytes = calls.list_workspaces.content_bytes + calls.list_workspaces.structured_bytes

	const actorsResult = await record('list_actors', 'list_actors', { ...ws, limit: 100 })
	const chosen = chooseActors(extractRows(actorsResult, 'actors'), config.actorIds)
	if (!chosen.pinned)
		warnings.push(
			'MASKIN_BASELINE_ACTOR_IDS not set: actors are unpinned, not comparable run to run',
		)
	for (const [i, id] of chosen.ids.entries()) {
		await record(`get_actor_${i + 1}`, 'get_actor', { ...ws, id })
	}

	await record('list_sessions_lean', 'list_sessions', { ...ws, limit: 25 })
	await record('list_sessions_verbose', 'list_sessions', { ...ws, limit: 25, verbose: true })

	const eventsWalk = await walkEvents(async ({ limit, cursor }) => {
		const result = await client.callTool('get_events', {
			...ws,
			limit,
			...(cursor ? { cursor } : {}),
		})
		return result
	})
	calls.get_events = eventsWalk.by_limit[100]
	const probeId = (deps.randomUuid ?? randomUUID)()
	const probe = await client.callTool('get_workspace_schema', { workspace_id: probeId })

	const { names: _names, allowlisted_not_read_only: _flagged, ...toolsPublic } = tools
	return {
		meta: {
			url: config.url,
			key_actor_type: config.keyActorType,
			workspaces_visible: wsCount,
			actors_pinned: chosen.pinned,
			rate_limited: client.state.rateLimited,
			server_name: init?.serverInfo?.name ?? null,
			server_version: init?.serverInfo?.version ?? null,
		},
		tools_list: toolsPublic,
		workspaces: {
			count: wsCount,
			bytes: wsBytes,
			bytes_per_row: wsCount > 0 ? Math.round(wsBytes / wsCount) : 0,
		},
		calls,
		events_walk: eventsWalk,
		schema_probe: classifySchemaProbe(probe, probeId),
		warnings,
		timing: { started_at: new Date(started).toISOString(), duration_ms: now() - started },
	}
}

export async function main(argv, env, io = {}) {
	const out = io.stdout ?? ((s) => process.stdout.write(s))
	const err = io.stderr ?? ((s) => process.stderr.write(s))
	let apiKey = env.MASKIN_API_KEY
	try {
		const config = loadConfig(env)
		apiKey = config.apiKey
		const report = await runBaseline(config, io.deps ?? {})
		out(argv.includes('--json') ? formatJson(report) : formatTable(report))
		return 0
	} catch (e) {
		err(`mcp-baseline failed: ${redact(e instanceof Error ? e.message : e, apiKey)}\n`)
		return exitCodeFor(e)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2), process.env)
}
