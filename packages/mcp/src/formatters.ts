/**
 * Markdown summary formatters for MCP tool results.
 *
 * Direction 1 of bet `mcp-lean-results`: every tool result returns a short
 * markdown summary (1–3 lines per object + a single deep link back into
 * maskin.app) as `content`, and the full untruncated JSON as
 * `structuredContent` for the model to reason over.
 *
 * Each entry point is a pure function from a payload shape to
 * `{ content, structuredContent }`. Task 4 wires them into the tool handlers
 * in `server.ts`; this module knows nothing about the MCP SDK, the API
 * client, or HTTP — just the data shapes and how to render them.
 */

import { type DeepLinkSettingsSection, deepLink } from './deep-link.js'

/**
 * Return shape every formatter produces. Task 4 wraps this into the MCP
 * `CallToolResult` (`content: [{ type: 'text', text }], structuredContent`).
 */
export interface FormattedResult {
	content: string
	structuredContent: unknown
}

/**
 * Shared call-site context: the originating MCP tool name, the workspace
 * the result belongs to, plus optional session id / base URL forwarded to
 * `deepLink()` for click tracking.
 */
export interface FormatterContext {
	workspaceId: string
	tool: string
	sessionId?: string
	baseUrl?: string
}

const PREVIEW_MAX = 140
const LIST_TRUNCATE_THRESHOLD = 25

/**
 * Defang user-controlled text before splicing into markdown. We escape the
 * characters that would let a malicious title / name / comment break out of
 * the surrounding `[text](url)` link or `` `code` `` span, and collapse CR/LF
 * so a multi-line value can't smuggle a heading or list bullet onto its own
 * line:
 *
 *   `\\`        — escaped first so the subsequent passes don't double-collapse
 *   `[` / `]`   — both halves of link-text syntax
 *   `` ` ``     — opens / closes inline code spans
 *   CR/LF       — collapsed to a single space
 *
 * We deliberately leave `*` / `_` / `#` / `(` / `)` alone: they don't open a
 * link or smuggle a click target in our render shapes, and over-escaping
 * turns common human punctuation into a noisy `\*foo\*` everywhere.
 */
export function escapeMd(s: string | null | undefined): string {
	if (!s) return ''
	return s
		.replace(/\\/g, '\\\\')
		.replace(/[`[\]]/g, '\\$&')
		.replace(/[\r\n]+/g, ' ')
}

interface ObjectSummary {
	id: string
	type?: string | null
	title?: string | null
	status?: string | null
	content?: string | null
	owner?: string | null
	updatedAt?: string | null
	createdAt?: string | null
}

interface EventSummary {
	id?: number
	action?: string
	createdAt?: string | null
	description?: string | null
}

interface ObjectGraph {
	object: ObjectSummary & Record<string, unknown>
	relationships?: Array<Record<string, unknown>>
	connected_objects?: Array<Record<string, unknown>>
	events?: EventSummary[]
	files?: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; url: string }>
}

interface UnreadItem {
	entity_type: string
	entity_id: string
	unread_count: number
	latest_event_id?: number | null
	latest_activity_at?: string | null
	object?: ObjectSummary
}

interface WorkspaceSchema {
	workspace_id: string
	workspace_name?: string
	relationship_types?: string[]
	types?: Record<
		string,
		{
			display_name?: string
			statuses?: string[]
			fields?: Array<{ name: string; type: string }>
		}
	>
}

function truncate(text: string, max = PREVIEW_MAX): string {
	const trimmed = text.replace(/\s+/g, ' ').trim()
	if (trimmed.length <= max) return trimmed
	return `${trimmed.slice(0, max - 1).trimEnd()}…`
}

function preview(text: string | null | undefined): string | null {
	if (!text) return null
	const trimmed = text.trim()
	if (!trimmed) return null
	return escapeMd(truncate(trimmed))
}

function objectLink(o: ObjectSummary, ctx: FormatterContext): string {
	return deepLink({
		workspaceId: ctx.workspaceId,
		kind: 'object',
		id: o.id,
		tool: ctx.tool,
		sessionId: ctx.sessionId,
		baseUrl: ctx.baseUrl,
	})
}

function workspaceLink(ctx: FormatterContext): string {
	return deepLink({
		workspaceId: ctx.workspaceId,
		kind: 'workspace',
		tool: ctx.tool,
		sessionId: ctx.sessionId,
		baseUrl: ctx.baseUrl,
	})
}

function safeTitle(o: ObjectSummary): string {
	const t = (o.title ?? '').trim()
	if (t) return escapeMd(t)
	const typeLabel = (o.type ?? 'object').toString()
	return `Untitled ${escapeMd(typeLabel)}`
}

function metaLine(o: ObjectSummary): string | null {
	const parts: string[] = []
	if (o.type) parts.push(escapeMd(o.type))
	if (o.status) parts.push(escapeMd(o.status))
	if (parts.length === 0) return null
	return `_${parts.join(' • ')}_`
}

function lastActivity(events: EventSummary[] | undefined): string | null {
	if (!events?.length) return null
	const first = events[0]
	if (!first?.description) return null
	return escapeMd(truncate(first.description, 120))
}

/**
 * Single-object summary. Used by `get_objects` (one block per id),
 * `get_session`/`get_actor` (when re-skinned in Task 4), and any tool that
 * returns a single object graph.
 *
 * Markdown shape:
 *
 * ```
 * #### [title](deepLink)
 * _type • status_
 * preview of content (truncated)
 * Last activity: <event description>
 * ```
 */
export function formatObject(graph: ObjectGraph, ctx: FormatterContext): FormattedResult {
	const o = graph.object
	const lines: string[] = []
	lines.push(`#### [${safeTitle(o)}](${objectLink(o, ctx)})`)
	const meta = metaLine(o)
	if (meta) lines.push(meta)
	const body = preview(o.content)
	if (body) lines.push(body)
	const activity = lastActivity(graph.events)
	if (activity) lines.push(`Last activity: ${activity}`)
	if (graph.files?.length) {
		lines.push(`${graph.files.length} attached file${graph.files.length === 1 ? '' : 's'}`)
	}
	return { content: lines.join('\n'), structuredContent: graph }
}

/**
 * Multi-result single-object renderer. Mirrors what `get_objects` returns
 * today: an array of `{ id, success, result? | error? }`. Each successful
 * entry renders as a `formatObject` block; failures render as a one-line
 * error so the model still sees which ids fell out.
 */
export function formatObjectBatch(
	results: Array<{ id: string; success: boolean; result?: ObjectGraph; error?: string }>,
	ctx: FormatterContext,
): FormattedResult {
	if (results.length === 0) {
		return { content: '_No objects returned._', structuredContent: results }
	}
	const blocks: string[] = []
	for (const entry of results) {
		if (entry.success && entry.result) {
			blocks.push(formatObject(entry.result, ctx).content)
		} else {
			blocks.push(`⚠️ \`${entry.id}\` — ${entry.error ?? 'not found'}`)
		}
	}
	return { content: blocks.join('\n\n'), structuredContent: results }
}

function renderObjectListItem(o: ObjectSummary, ctx: FormatterContext): string {
	const lines: string[] = []
	lines.push(`#### [${safeTitle(o)}](${objectLink(o, ctx)})`)
	const meta = metaLine(o)
	if (meta) lines.push(meta)
	const body = preview(o.content)
	if (body) lines.push(body)
	return lines.join('\n')
}

/**
 * Page-of-objects summary. Used by `list_objects` and any other tool that
 * returns a flat array of object rows. Items are grouped by `type` so a
 * mixed list of bets and tasks renders as two sections instead of a
 * flat blob.
 */
export function formatObjectList(objects: ObjectSummary[], ctx: FormatterContext): FormattedResult {
	if (objects.length === 0) {
		return { content: '_No objects matched._', structuredContent: objects }
	}
	const byType = new Map<string, ObjectSummary[]>()
	for (const o of objects) {
		const key = (o.type ?? 'object').toString()
		const bucket = byType.get(key)
		if (bucket) bucket.push(o)
		else byType.set(key, [o])
	}
	const sections: string[] = []
	for (const [type, items] of byType) {
		const label = items.length === 1 ? type : `${type}s`
		sections.push(`**${items.length} ${label}**`)
		const shown = items.slice(0, LIST_TRUNCATE_THRESHOLD)
		for (const item of shown) {
			sections.push(renderObjectListItem(item, ctx))
		}
		if (items.length > shown.length) {
			sections.push(`…and ${items.length - shown.length} more`)
		}
	}
	return { content: sections.join('\n\n'), structuredContent: objects }
}

/**
 * Search-hits summary. Adds a heading naming the query and a link to the
 * search results page in maskin.app; each hit renders as a list item with
 * its content preview (which doubles as the "top match snippet" for v1 —
 * the search API doesn't return per-hit highlights yet).
 */
export function formatSearchHits(
	input: { q: string; hits: ObjectSummary[]; type?: string },
	ctx: FormatterContext,
): FormattedResult {
	const searchUrl = deepLink({
		workspaceId: ctx.workspaceId,
		kind: 'search',
		query: input.q,
		tool: ctx.tool,
		sessionId: ctx.sessionId,
		baseUrl: ctx.baseUrl,
	})
	const header = `**${input.hits.length} result${input.hits.length === 1 ? '' : 's'}** for "${escapeMd(input.q)}" — [open in Maskin](${searchUrl})`
	if (input.hits.length === 0) {
		return { content: `${header}\n\n_No matches._`, structuredContent: input.hits }
	}
	const shown = input.hits.slice(0, LIST_TRUNCATE_THRESHOLD)
	const blocks = shown.map((hit) => renderObjectListItem(hit, ctx))
	if (input.hits.length > shown.length) {
		blocks.push(`…and ${input.hits.length - shown.length} more`)
	}
	return { content: [header, ...blocks].join('\n\n'), structuredContent: input.hits }
}

/**
 * Unread-digest summary. Headline links to the workspace activity view; each
 * item renders as a one-line `title — N unread` row with a deep link if the
 * entity is an object (we don't hydrate sessions/actors in v1).
 */
export function formatUnreadDigest(
	payload: { items: UnreadItem[] },
	ctx: FormatterContext,
): FormattedResult {
	const activityUrl = deepLink({
		workspaceId: ctx.workspaceId,
		kind: 'unread',
		tool: ctx.tool,
		sessionId: ctx.sessionId,
		baseUrl: ctx.baseUrl,
	})
	const total = payload.items.reduce((sum, i) => sum + (i.unread_count ?? 0), 0)
	const header = `**${total} unread** across ${payload.items.length} thread${payload.items.length === 1 ? '' : 's'} — [open activity](${activityUrl})`
	if (payload.items.length === 0) {
		return { content: `${header}\n\n_Inbox zero._`, structuredContent: payload }
	}
	const lines: string[] = [header, '']
	for (const item of payload.items.slice(0, LIST_TRUNCATE_THRESHOLD)) {
		const title = item.object
			? safeTitle(item.object)
			: `${item.entity_type} ${item.entity_id.slice(0, 8)}`
		const link =
			item.object && item.entity_type === 'object'
				? objectLink(item.object, ctx)
				: workspaceLink(ctx)
		lines.push(`- [${title}](${link}) — ${item.unread_count} unread`)
	}
	if (payload.items.length > LIST_TRUNCATE_THRESHOLD) {
		lines.push(`…and ${payload.items.length - LIST_TRUNCATE_THRESHOLD} more`)
	}
	return { content: lines.join('\n'), structuredContent: payload }
}

/**
 * Workspace-schema summary. Headline names the workspace with a deep link;
 * one line per object type lists status options at a glance so the model
 * doesn't have to scan the full JSON to know what `status` values are valid.
 */
export function formatWorkspaceSummary(
	schema: WorkspaceSchema,
	ctx: FormatterContext,
): FormattedResult {
	const url = workspaceLink(ctx)
	const lines: string[] = []
	lines.push(`#### [${escapeMd(schema.workspace_name ?? 'Workspace')}](${url})`)
	const types = schema.types ? Object.entries(schema.types) : []
	if (types.length > 0) {
		for (const [type, def] of types) {
			const label = escapeMd(def.display_name ?? type)
			const statuses = def.statuses?.length
				? ` — statuses: ${def.statuses.map(escapeMd).join(', ')}`
				: ''
			lines.push(`- **${label}**${statuses}`)
		}
	}
	if (schema.relationship_types?.length) {
		lines.push('')
		lines.push(`Relationship types: ${schema.relationship_types.map(escapeMd).join(', ')}`)
	}
	return { content: lines.join('\n'), structuredContent: schema }
}

/**
 * Mutation-confirm summary. Generic shape for write tools: a short success
 * line, optional per-result bullets if multiple ops were batched (e.g.
 * `create_objects`, `update_objects`), and a deep link to the most relevant
 * surface (the first successful object, or the workspace if none).
 */
export function formatMutationConfirm(
	input: {
		verb: string
		results: Array<{
			type?: string
			id?: string
			success: boolean
			skipped?: boolean
			result?: { id?: string; title?: string; type?: string } & Record<string, unknown>
			error?: string
		}>
		section?: DeepLinkSettingsSection
	},
	ctx: FormatterContext,
): FormattedResult {
	const ok = input.results.filter((r) => r.success).length
	const failed = input.results.length - ok

	const firstSuccess = input.results.find((r) => r.success && r.result?.id)?.result
	const link = firstSuccess?.id
		? deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'object',
				id: firstSuccess.id,
				tool: ctx.tool,
				sessionId: ctx.sessionId,
				baseUrl: ctx.baseUrl,
			})
		: input.section
			? deepLink({
					workspaceId: ctx.workspaceId,
					kind: 'settings',
					section: input.section,
					tool: ctx.tool,
					sessionId: ctx.sessionId,
					baseUrl: ctx.baseUrl,
				})
			: workspaceLink(ctx)

	const status = failed === 0 ? '✅' : ok === 0 ? '❌' : '⚠️'
	const summary = `${status} **${escapeMd(input.verb)}**: ${ok} succeeded${failed ? `, ${failed} failed` : ''} — [open in Maskin](${link})`

	const lines: string[] = [summary]
	if (failed > 0) {
		lines.push('')
		for (const r of input.results.filter((x) => !x.success).slice(0, 10)) {
			const label = escapeMd(r.id ?? r.type ?? 'item')
			const err = escapeMd(r.error ?? 'unknown error')
			lines.push(`- ❌ \`${label}\` — ${err}`)
		}
	}
	return { content: lines.join('\n'), structuredContent: input.results }
}
