import { READ_TOOL_NAMES } from './read-error.js'
import { MUTATION_TOOL_KINDS } from './telemetry.js'

/**
 * How a hands-free call treats a tool.
 *
 * - `read`: runs immediately.
 * - `write`: runs immediately; a low-stakes, easily reversed change.
 * - `confirm`: the person must say or tap yes first. Covers anything destructive,
 *   anything that changes configuration or wakes other agents, and a few
 *   argument shapes of otherwise-safe tools.
 * - `excluded`: never advertised to a live call (container-only, browser-only,
 *   or unsuited to being read aloud).
 *
 * Every tool in `tools.ts` must be classified here. tool-risk.test.ts fails
 * until a new tool is, so a new tool cannot silently default to `write`.
 */
export type ToolRisk = 'read' | 'write' | 'confirm' | 'excluded'

/** Never offered to a live call. */
export const LIVE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
	'create_workspace', // changes tenancy
	'connect_integration', // needs a browser OAuth hop
	'get_session_logs', // log dumps are unreadable aloud
	'get_file', // binary or very long payloads
	'create_file', // long-form content belongs in chat
	'update_file',
	'list_workspaces', // cross-workspace; the call is bound to one
	'get_started',
])

/** Reads that are not in READ_TOOL_NAMES (it predates the conversation and graph tools). */
const EXTRA_READ_TOOLS: ReadonlySet<string> = new Set([
	'traverse_graph',
	'get_conversation',
	'list_conversation_messages',
	'get_session_activity',
	'list_notifications',
	'get_notification',
])

/** Writes that are reversible or low-stakes enough to run without asking. */
const SAFE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'create_objects',
	'update_objects',
	'create_relationship',
	'create_comment',
	'mark_read',
	'update_notification',
])

const COMMENT_MAX_ATTENTION = 3
const SAFE_CREATE_TYPES: ReadonlySet<string> = new Set(['insight', 'task', 'bet'])
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	'done',
	'closed',
	'cancelled',
	'canceled',
	'archived',
	'succeeded',
	'failed',
	'rejected',
	'shipped',
	'merged',
])

function isObject(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v)
}

/** True when a normally-safe write carries arguments that make it risky. */
function argumentsNeedConfirmation(name: string, args: unknown): boolean {
	if (!isObject(args)) return false
	if (name === 'create_comment') {
		if (typeof args.attention === 'number' && args.attention > COMMENT_MAX_ATTENTION) return true
		const mentions = args.mentions
		// A mention spawns an agent session. Fail closed on anything but absent or empty.
		if (mentions != null && !(Array.isArray(mentions) && mentions.length === 0)) return true
		return false
	}
	if (name === 'create_objects') {
		const nodes = args.nodes
		if (!Array.isArray(nodes) || nodes.length === 0) return true
		return nodes.some(
			(n) => !isObject(n) || typeof n.type !== 'string' || !SAFE_CREATE_TYPES.has(n.type),
		)
	}
	if (name === 'update_objects') {
		const updates = args.updates
		if (!Array.isArray(updates)) return false
		return updates.some(
			(u) =>
				isObject(u) &&
				typeof u.status === 'string' &&
				TERMINAL_STATUSES.has(u.status.trim().toLowerCase()),
		)
	}
	return false
}

export function toolRisk(name: string, args?: unknown): ToolRisk {
	if (LIVE_EXCLUDED_TOOLS.has(name)) return 'excluded'
	if (READ_TOOL_NAMES.has(name) || EXTRA_READ_TOOLS.has(name)) return 'read'
	if (SAFE_WRITE_TOOLS.has(name)) {
		return argumentsNeedConfirmation(name, args) ? 'confirm' : 'write'
	}
	// Everything else that mutates, and any tool nobody has classified, asks first.
	return 'confirm'
}

/** True when the tool is known to this table (used by the coverage test). */
export function isClassifiedTool(name: string): boolean {
	return (
		LIVE_EXCLUDED_TOOLS.has(name) ||
		READ_TOOL_NAMES.has(name) ||
		EXTRA_READ_TOOLS.has(name) ||
		SAFE_WRITE_TOOLS.has(name) ||
		name in MUTATION_TOOL_KINDS ||
		CONFIRM_ONLY_TOOLS.has(name)
	)
}

/** Mutating tools that are not in MUTATION_TOOL_KINDS but must still ask first. */
export const CONFIRM_ONLY_TOOLS: ReadonlySet<string> = new Set([
	'post_conversation_message', // would double-post what the call already persists
	'create_notification',
	'delete_notification',
])
