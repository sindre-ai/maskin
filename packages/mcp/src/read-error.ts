/**
 * Structured error responses for read-side MCP tools (list_*, search_*, get_*).
 *
 * The MCP framework surfaces thrown handler errors as generic transport-level
 * failures — the calling LLM sees a raw message with no hint about what to
 * try next. This module converts caught errors into a stable, teachable JSON
 * envelope: `{ error: { tool, reason, next: { tool, hint } } }`. Handlers wrap
 * their body in try/catch and return `toolErrorResponse(name, err)` on catch.
 *
 * The `next` field is the load-bearing piece: future callers pattern-match on
 * `error.next.tool` to auto-recover, so the shape is intentionally minimal and
 * the per-tool mapping lives here (not scattered across handlers) to keep it
 * stable across tools.
 */

export type ReadErrorKind =
	| 'not_found'
	| 'invalid_param'
	| 'permission'
	| 'rate_limit'
	| 'server'
	/**
	 * A terminal, provider-side condition that retrying cannot clear and will
	 * often make worse — a disconnected credential, or an account the upstream
	 * platform has restricted. Distinct from `permission` (which is about the
	 * caller's Maskin access) and from `unknown` (whose guidance suggests one
	 * retry). Only reachable when the backend sends a machine-readable
	 * `error.code`; see `TERMINAL_PROVIDER_CODES`.
	 */
	| 'provider_terminal'
	| 'unknown'

/**
 * Backend `error.code` values that must never be retried. These come from the
 * LinkedIn/Unipile taxonomy in
 * `apps/dev/src/lib/integrations/providers/linkedin-unipile/errors.ts`, whose
 * HTTP statuses (424 CREDENTIAL_NOT_CONNECTED, 423 LINKEDIN_ACCOUNT_RESTRICTED)
 * match no branch of the status-based classification below and would otherwise
 * land in `unknown`.
 */
const TERMINAL_PROVIDER_CODES = new Set<string>([
	'CREDENTIAL_NOT_CONNECTED',
	'CREDENTIAL_REVOKED',
	'LINKEDIN_ACCOUNT_RESTRICTED',
])

/**
 * Recover the backend's machine-readable `error.code`, which `apiFetch`
 * attaches to the thrown Error (server.ts). Returns null for errors raised
 * anywhere else.
 */
export function apiErrorCodeOf(err: unknown): string | null {
	if (!err || typeof err !== 'object') return null
	const code = (err as { apiErrorCode?: unknown }).apiErrorCode
	return typeof code === 'string' && code.length > 0 ? code : null
}

export interface ReadErrorNext {
	tool: string
	hint: string
}

export interface ReadErrorBody {
	error: {
		tool: string
		reason: string
		next: ReadErrorNext
	}
	/**
	 * The MCP SDK types `structuredContent` as `{ [x: string]: unknown }`, and a
	 * plain interface is not assignable to that. Without this signature a handler
	 * that returns `toolErrorResponse(...)` from a catch beside a success return
	 * fails to type-check on the union — the error is reported against the
	 * handler, not against this type, so it reads as a bug in the tool. `error`
	 * above stays the only field anything reads or writes.
	 */
	[key: string]: unknown
}

/**
 * Parse the HTTP status code out of an `apiFetch` error. The wrapper throws
 * `new Error("API error <status>: <detail>")` (server.ts:333), so a regex on
 * the message is the cheapest way to recover the status without threading a
 * typed error class through every call site.
 */
export function parseApiErrorStatus(err: unknown): number | null {
	const message = err instanceof Error ? err.message : String(err)
	const match = message.match(/^API error (\d{3})\b/)
	if (!match) return null
	const status = Number.parseInt(match[1] as string, 10)
	return Number.isFinite(status) ? status : null
}

/**
 * Best-effort human-readable reason from an error. Strips the `API error
 * <status>:` prefix if present so the reason reads like a sentence and doesn't
 * duplicate information the classification already carries.
 */
export function reasonFromError(err: unknown, kind: ReadErrorKind): string {
	const raw = (err instanceof Error ? err.message : String(err)).trim()
	const stripped = raw.replace(/^API error \d{3}:\s*/i, '').trim()
	const detail = stripped.length > 0 ? stripped : raw
	switch (kind) {
		case 'not_found':
			return `Not found: ${detail}`
		case 'invalid_param':
			return `Invalid argument: ${detail}`
		case 'permission':
			return `Permission denied: ${detail}`
		case 'rate_limit':
			return `Rate limited: ${detail}`
		case 'server':
			return `Upstream error: ${detail}`
		case 'provider_terminal':
			return `Connection unavailable: ${detail}`
		default:
			return `Unexpected error: ${detail}`
	}
}

export function classifyReadError(err: unknown): ReadErrorKind {
	// Code first: a terminal provider condition outranks its HTTP status, and
	// its statuses (423/424) match none of the branches below anyway.
	const code = apiErrorCodeOf(err)
	if (code !== null && TERMINAL_PROVIDER_CODES.has(code)) return 'provider_terminal'
	const status = parseApiErrorStatus(err)
	if (status === 423 || status === 424) return 'provider_terminal'
	if (status === 404) return 'not_found'
	if (status === 400 || status === 422) return 'invalid_param'
	if (status === 401 || status === 403) return 'permission'
	if (status === 429) return 'rate_limit'
	if (status !== null && status >= 500) return 'server'
	const message = err instanceof Error ? err.message : String(err)
	// Local pre-flight guards in server.ts throw plain-text errors before ever
	// hitting the API — treat them as invalid-param so the caller gets pointed
	// at the same tool with a corrected example rather than a search fallback.
	if (/^No workspace specified/i.test(message)) return 'invalid_param'
	if (/^Not authenticated/i.test(message)) return 'permission'
	if (/not found/i.test(message)) return 'not_found'
	return 'unknown'
}

/**
 * Per-tool guidance for what the caller should try next when a read fails.
 * Kept as a static table so the mapping is auditable in one place and the
 * error shape stays stable — future callers rely on `next.tool`.
 */
interface ToolGuidance {
	notFound: ReadErrorNext
	invalidParam: ReadErrorNext
	permission?: ReadErrorNext
	/** Overrides the default do-not-retry guidance for `provider_terminal`. */
	providerTerminal?: ReadErrorNext
}

const DEFAULT_PERMISSION: ReadErrorNext = {
	tool: 'list_workspaces',
	hint: 'Confirm the caller has access to a workspace, then retry with a valid workspace_id.',
}

/**
 * Names of every read-side MCP tool (list_*, search_*, get_*). The
 * registerAppTool wrapper in server.ts consults this set to decide whether a
 * thrown handler error should be surfaced as a structured error response or
 * re-thrown as-is. Kept in sync with the GUIDANCE table below — see the
 * assertion in read-error.test.ts.
 */
export const READ_TOOL_NAMES = new Set<string>([
	'get_objects',
	'list_objects',
	'search_objects',
	'list_relationships',
	'list_actors',
	'get_actor',
	'list_workspaces',
	'get_workspace_schema',
	'list_workspace_skills',
	'get_workspace_skill',
	'list_files',
	'get_file',
	'get_events',
	'get_comments',
	'list_triggers',
	'list_loops',
	'get_loop',
	'list_unread',
	'list_sessions',
	'get_session',
	'list_integrations',
	'list_integration_providers',
	'list_extensions',
	'get_started',
])

const GUIDANCE: Record<string, ToolGuidance> = {
	get_objects: {
		notFound: {
			tool: 'search_objects',
			hint: 'search_objects({ q: "<title fragment>" }) to find the object by title before retrying with its id.',
		},
		invalidParam: {
			tool: 'get_objects',
			hint: 'get_objects({ ids: ["<uuid>"] }) — ids must be an array of UUIDs (max 50); pass workspace_id if not using the default.',
		},
	},
	list_objects: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm the target workspace exists, then retry with a valid workspace_id.',
		},
		invalidParam: {
			tool: 'list_objects',
			hint: 'list_objects({ type: "bet", status: "active", limit: 25 }) — see get_workspace_schema for valid types and statuses.',
		},
	},
	search_objects: {
		notFound: {
			tool: 'list_objects',
			hint: 'list_objects({ type: "<type>" }) to browse without a query — search only ranks matches and returns empty when nothing hits.',
		},
		invalidParam: {
			tool: 'search_objects',
			hint: 'search_objects({ q: "roadmap" }) — q is required and must be a non-empty string; type/status are optional filters.',
		},
	},
	list_relationships: {
		notFound: {
			tool: 'search_objects',
			hint: 'search_objects to locate the object first, then list_relationships({ object_id: "<uuid>" }) with a valid id.',
		},
		invalidParam: {
			tool: 'list_relationships',
			hint: 'list_relationships({ object_id: "<uuid>" }) — object_id/source_id/target_id must be UUIDs when provided.',
		},
	},
	list_actors: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_actors({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_actors',
			hint: 'list_actors({ workspace_id: "<uuid>", limit: 50 }) — omit workspace_id to list across all accessible workspaces.',
		},
	},
	get_actor: {
		notFound: {
			tool: 'list_actors',
			hint: 'list_actors() to find the actor and its id before retrying get_actor({ id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'get_actor',
			hint: 'get_actor({ id: "<uuid>" }) — id must be a UUID.',
		},
	},
	list_workspaces: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() takes no required arguments — retry without extra params.',
		},
		invalidParam: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() takes no arguments — call it with an empty input.',
		},
		permission: {
			tool: 'list_workspaces',
			hint: 'The current credentials cannot list workspaces. Verify the API key has workspace access.',
		},
	},
	get_workspace_schema: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to find a valid workspace_id, then get_workspace_schema({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'get_workspace_schema',
			hint: 'get_workspace_schema({ workspace_id: "<uuid>", type: "bet" }) — type is optional and must be a valid object type when provided.',
		},
	},
	list_workspace_skills: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_workspace_skills({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_workspace_skills',
			hint: 'list_workspace_skills({ workspace_id: "<uuid>", limit: 50 }).',
		},
	},
	get_workspace_skill: {
		notFound: {
			tool: 'list_workspace_skills',
			hint: 'list_workspace_skills({ workspace_id: "<uuid>" }) to find valid skill names, then retry get_workspace_skill({ name: "<name>" }).',
		},
		invalidParam: {
			tool: 'get_workspace_skill',
			hint: 'get_workspace_skill({ workspace_id: "<uuid>", name: "<skill-name>" }) — name must be a non-empty string.',
		},
	},
	list_files: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_files({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_files',
			hint: 'list_files({ workspace_id: "<uuid>", q: "<optional query>" }).',
		},
	},
	get_file: {
		notFound: {
			tool: 'list_files',
			hint: 'list_files() to find a valid file id, then retry get_file({ id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'get_file',
			hint: 'get_file({ id: "<uuid>" }) — id must be a UUID.',
		},
	},
	get_events: {
		notFound: {
			tool: 'get_events',
			hint: 'get_events() without filters returns the latest events — narrow with entity_type/action once you see valid values.',
		},
		invalidParam: {
			tool: 'get_events',
			hint: 'get_events({ entity_type: "object", action: "created", limit: 50 }) — id must be a positive integer when set.',
		},
	},
	get_comments: {
		notFound: {
			tool: 'search_objects',
			hint: 'search_objects to find the object first, then get_comments({ entity_id: "<uuid>" }) — comments live on existing objects.',
		},
		invalidParam: {
			tool: 'get_comments',
			hint: 'get_comments({ entity_id: "<uuid>", limit: 50, offset: 0 }) — entity_id must be a UUID.',
		},
	},
	list_triggers: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_triggers({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_triggers',
			hint: 'list_triggers({ workspace_id: "<uuid>", limit: 50 }).',
		},
	},
	list_loops: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_loops({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_loops',
			hint: 'list_loops({ workspace_id: "<uuid>" }).',
		},
	},
	get_loop: {
		notFound: {
			tool: 'list_loops',
			hint: 'list_loops() to find a valid loop id, then retry get_loop({ id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'get_loop',
			hint: 'get_loop({ id: "<uuid>" }) — id must be a UUID.',
		},
	},
	list_unread: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_unread({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_unread',
			hint: 'list_unread({ entity_type: "object" }) — entity_type is optional and filters to that entity type only.',
		},
	},
	list_sessions: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_sessions({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_sessions',
			hint: 'list_sessions({ workspace_id: "<uuid>", status: "running", limit: 50 }).',
		},
	},
	get_session: {
		notFound: {
			tool: 'list_sessions',
			hint: 'list_sessions() to find a valid session id, then retry get_session({ id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'get_session',
			hint: 'get_session({ id: "<uuid>", include_logs: true }) — id must be a UUID.',
		},
	},
	list_integrations: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_integrations({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_integrations',
			hint: 'list_integrations({ workspace_id: "<uuid>" }).',
		},
	},
	list_integration_providers: {
		notFound: {
			tool: 'list_integration_providers',
			hint: 'list_integration_providers() takes no arguments — retry with an empty input.',
		},
		invalidParam: {
			tool: 'list_integration_providers',
			hint: 'list_integration_providers() takes no arguments — call it with an empty input.',
		},
	},
	list_extensions: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then list_extensions({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'list_extensions',
			hint: 'list_extensions({ workspace_id: "<uuid>" }) — workspace_id defaults to the configured workspace when omitted.',
		},
	},
	// The three LinkedIn tools call toolErrorResponse directly from their
	// handlers rather than through the READ_TOOL_NAMES branch, so without
	// entries here they fell back to list_workspaces guidance — useless advice
	// for a failed send.
	linkedin__send_message: {
		notFound: {
			tool: 'linkedin__list_conversations',
			hint: 'linkedin__list_conversations() to confirm the recipient is reachable, then retry with a valid recipient_urn.',
		},
		invalidParam: {
			tool: 'linkedin__send_message',
			hint: 'linkedin__send_message({ recipient_urn: "<urn>", text: "<message>", idempotency_key: "<contact_id>:<draft_id>" }) — recipient_urn and text are required.',
		},
	},
	linkedin__reply: {
		notFound: {
			tool: 'linkedin__list_conversations',
			hint: 'linkedin__list_conversations() to get a current thread_id — the thread may have been deleted or archived.',
		},
		invalidParam: {
			tool: 'linkedin__reply',
			hint: 'linkedin__reply({ thread_id: "<id>", text: "<message>", idempotency_key: "<contact_id>:<draft_id>" }) — thread_id and text are required. Use a different idempotency_key than the original send.',
		},
	},
	linkedin__list_conversations: {
		notFound: {
			tool: 'list_integrations',
			hint: 'list_integrations() to confirm this actor has a connected linkedin-unipile credential in the workspace.',
		},
		invalidParam: {
			tool: 'linkedin__list_conversations',
			hint: 'linkedin__list_conversations({ limit: 25 }) — limit must be a positive integer when provided.',
		},
	},
	get_started: {
		notFound: {
			tool: 'list_workspaces',
			hint: 'list_workspaces() to confirm workspace access, then get_started({ workspace_id: "<uuid>" }).',
		},
		invalidParam: {
			tool: 'get_started',
			hint: 'get_started({ workspace_id: "<uuid>", loop_id: "<uuid>", confirm: true }) — call without args first to see available loops.',
		},
	},
}

const FALLBACK_GUIDANCE: ToolGuidance = {
	notFound: {
		tool: 'list_workspaces',
		hint: 'Confirm the caller has workspace access with list_workspaces() before retrying.',
	},
	invalidParam: {
		tool: 'list_workspaces',
		hint: 'Re-check the arguments against the tool schema. Start with list_workspaces() to confirm access.',
	},
}

/**
 * Pick the `next` hint appropriate for the failing tool + error kind.
 * Extracted so tests can lock in the mapping without going through the full
 * response envelope.
 */
export function pickNext(toolName: string, kind: ReadErrorKind): ReadErrorNext {
	const guidance = GUIDANCE[toolName] ?? FALLBACK_GUIDANCE
	switch (kind) {
		case 'not_found':
			return guidance.notFound
		case 'invalid_param':
			return guidance.invalidParam
		case 'permission':
			return guidance.permission ?? DEFAULT_PERMISSION
		case 'rate_limit':
			return {
				tool: toolName,
				hint: 'Back off and retry the same call — the upstream API is rate-limiting this workspace.',
			}
		case 'server':
			return {
				tool: toolName,
				hint: 'Retry the same call after a short delay — the upstream API returned a transient server error.',
			}
		case 'provider_terminal':
			// Deliberately no retry advice. For a restricted account, retrying
			// worsens the upstream restriction; for a missing or revoked
			// credential, no number of retries will produce one.
			return (
				guidance.providerTerminal ?? {
					tool: 'list_integrations',
					hint: 'Do NOT retry — this needs a human. The account is disconnected or restricted upstream. Check list_integrations, then have the owning actor reconnect it in Settings > Integrations, and report this to the user instead of calling the tool again.',
				}
			)
		default:
			// Unrecognized error shape — do NOT reuse `notFound` guidance here.
			// An unclassified error is as likely to be a bug as a missing
			// resource; steering the caller straight into a "search again"
			// loop would mask the failure instead of surfacing it.
			return {
				tool: toolName,
				hint: 'This may be an unexpected server-side error rather than a missing resource. Retry once; if it persists, report the tool name and reason verbatim instead of retrying further.',
			}
	}
}

/**
 * Build the structured `{ error: { tool, reason, next } }` body for a caught
 * error. Callers wrap the whole handler body and pass the caught error here.
 */
export function buildReadErrorBody(toolName: string, err: unknown): ReadErrorBody {
	const kind = classifyReadError(err)
	return {
		error: {
			tool: toolName,
			reason: reasonFromError(err, kind),
			next: pickNext(toolName, kind),
		},
	}
}

/**
 * MCP response envelope for a caught read-side error. Compact JSON only (no
 * pretty-print), consistent with the T1 lean-response contract. Always sets
 * `_meta.toolName` so the card runtime can still identify which tool the
 * failure came from — same shape as every success response.
 */
export function toolErrorResponse(
	toolName: string,
	err: unknown,
	extra?: { _meta?: Record<string, unknown> },
): {
	_meta: Record<string, unknown>
	content: Array<{ type: 'text'; text: string }>
	structuredContent: ReadErrorBody
	isError: true
} {
	const body = buildReadErrorBody(toolName, err)
	return {
		_meta: { toolName, ...(extra?._meta ?? {}) },
		content: [{ type: 'text' as const, text: JSON.stringify(body) }],
		structuredContent: body,
		isError: true,
	}
}
