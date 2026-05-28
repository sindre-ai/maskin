/**
 * Deep-link URL helper for MCP tool results.
 *
 * Every URL produced by this module is routed through the `/r/:workspaceId[/...]`
 * click-tracking redirect that ships with Task 1 of bet `mcp-lean-results`
 * (see `apps/dev/src/routes/deep-link.ts`). The redirect logs one row to
 * `mcp_telemetry` (event_type=`deep_link_click`) and 302s to the canonical
 * SPA path — so callers get tracking for free without thinking about it.
 *
 * Example URLs per kind (base = `https://maskin.app`, workspaceId = `WS`,
 * tool = `get_objects`):
 *
 * | kind        | result                                                       |
 * | ----------- | ------------------------------------------------------------ |
 * | workspace   | `https://maskin.app/r/WS?t=get_objects`                      |
 * | object      | `https://maskin.app/r/WS/objects/OID?t=get_objects`          |
 * | comments    | `https://maskin.app/r/WS/objects/OID?t=get_comments`         |
 * | unread      | `https://maskin.app/r/WS/activity?t=list_unread`             |
 * | search      | `https://maskin.app/r/WS/objects?q=launch&t=search_objects`  |
 * | list        | `https://maskin.app/r/WS/objects?type=bet&t=list_objects`    |
 * | actor       | `https://maskin.app/r/WS/agents/AID?t=list_actors`           |
 * | trigger     | `https://maskin.app/r/WS/triggers/TID?t=list_triggers`       |
 * | settings    | `https://maskin.app/r/WS/settings/keys?t=...`                |
 *
 * `comments` lands on the object detail page — there's no separate comments
 * route today, but the tool name in `?t=` preserves the intent for the click
 * log so analytics can still distinguish "came in via get_comments" from
 * "came in via get_objects" without a URL-shape change.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a string is a valid UUID — the same shape `deepLink` requires for
 * `workspaceId`. Callers that operate without a default workspace (stdio
 * without `WORKSPACE_ID`, hosted MCP without `X-Workspace-Id`) use this to
 * branch into a no-link rendering path instead of letting `deepLink` throw.
 */
export function isValidWorkspaceId(id: string | null | undefined): id is string {
	return typeof id === 'string' && UUID_RE.test(id)
}

/**
 * Canonical kinds an MCP tool result can deep-link to. Aligned with the kinds
 * the Task 1 redirect classifier emits so the click-log surface column stays
 * consistent end-to-end. `comments` is intentionally MCP-only — it maps to an
 * object-detail URL but lets the tool name reflect the originating surface.
 */
export type DeepLinkKind =
	| 'workspace'
	| 'object'
	| 'comments'
	| 'unread'
	| 'search'
	| 'list'
	| 'actor'
	| 'trigger'
	| 'settings'

/**
 * Settings sub-section. Mirrors the file tree under
 * `apps/web/src/routes/_authed/$workspaceId/settings/`. Kept inline here
 * rather than re-imported from `@maskin/shared` so this module stays a
 * single small file with no cross-package coupling beyond `process.env`.
 */
export type DeepLinkSettingsSection =
	| 'integrations'
	| 'keys'
	| 'mcp'
	| 'members'
	| 'skills'
	| 'objects'

export interface DeepLinkInput {
	workspaceId: string
	kind: DeepLinkKind
	/** Object id, actor id, trigger id. Required for `object` and `comments`. */
	id?: string
	/** MCP tool that generated this link (e.g. `get_objects`). Logged on click. */
	tool: string
	/** MCP session id, if available — lets click analytics join back to a session. */
	sessionId?: string
	/** Search query, for `kind: 'search'`. */
	query?: string
	/** Object type filter, for `kind: 'list'`. */
	type?: string
	/** Settings sub-section, for `kind: 'settings'`. */
	section?: DeepLinkSettingsSection
	/** Override the base URL. Defaults to `WEB_APP_URL` env, then `FRONTEND_URL`, then `https://maskin.app`. */
	baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://maskin.app'

function resolveBaseUrl(override?: string): string {
	const raw = override ?? process.env.WEB_APP_URL ?? process.env.FRONTEND_URL ?? DEFAULT_BASE_URL
	return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

/**
 * Build the `/{workspaceId}/...` SPA path + query for the target. The path
 * is what the Task 1 redirect forwards verbatim; the query is what gets
 * appended to it (alongside the `t`/`s` click-tracking params).
 */
function buildAppPathAndQuery(input: DeepLinkInput): {
	path: string
	query: URLSearchParams
} {
	const root = `/${input.workspaceId}`
	const query = new URLSearchParams()

	switch (input.kind) {
		case 'workspace':
			return { path: root, query }
		case 'unread':
			return { path: `${root}/activity`, query }
		case 'object':
		case 'comments':
			if (!input.id) {
				throw new Error(`deepLink: kind='${input.kind}' requires id`)
			}
			return { path: `${root}/objects/${input.id}`, query }
		case 'search':
			if (input.query) query.set('q', input.query)
			return { path: `${root}/objects`, query }
		case 'list':
			if (input.type) query.set('type', input.type)
			return { path: `${root}/objects`, query }
		case 'actor':
			return {
				path: input.id ? `${root}/agents/${input.id}` : `${root}/agents`,
				query,
			}
		case 'trigger':
			return {
				path: input.id ? `${root}/triggers/${input.id}` : `${root}/triggers`,
				query,
			}
		case 'settings':
			return {
				path: input.section ? `${root}/settings/${input.section}` : `${root}/settings`,
				query,
			}
		default: {
			const _exhaustive: never = input.kind
			throw new Error(`deepLink: unknown kind ${String(_exhaustive)}`)
		}
	}
}

/**
 * Produce a canonical maskin.app deep-link URL for an MCP tool result.
 *
 * The returned URL is always shaped `${base}/r/{workspaceId}/<rest>?...` so
 * the Task 1 redirect endpoint logs the click before the user lands on the
 * SPA. Throws on missing required fields (e.g. `id` for `object`) or a
 * non-UUID `workspaceId` — both indicate a programmer error at the call
 * site, not a runtime degrade case.
 */
export function deepLink(input: DeepLinkInput): string {
	if (!UUID_RE.test(input.workspaceId)) {
		throw new Error(`deepLink: invalid workspaceId ${input.workspaceId}`)
	}
	if (!input.tool) {
		throw new Error('deepLink: tool is required')
	}

	const base = resolveBaseUrl(input.baseUrl)
	const { path, query } = buildAppPathAndQuery(input)

	// Click-tracking params consumed by the `/r` endpoint and stripped before
	// the 302. Everything else in `query` is forwarded to the SPA verbatim.
	query.set('t', input.tool)
	if (input.sessionId) query.set('s', input.sessionId)

	const qs = query.toString()
	return qs ? `${base}/r${path}?${qs}` : `${base}/r${path}`
}
