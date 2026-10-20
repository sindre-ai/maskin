import { POSTHOG_NEVER_READ, POSTHOG_READ_TOOLS } from './posthog-read-tools'

/**
 * Whether an integration tool only reads or can change something. The gate in
 * tool-gate.ts uses this to decide which tools a read-only agent may call.
 *
 * Fail-closed: a tool nobody classified is a write. A wrong "write" costs a refused
 * call and an obvious message; a wrong "read" lets an agent take an action it was
 * never allowed to.
 *
 * Order of evidence, strongest first:
 *   1. the curated sets below, for tools we register ourselves (Slack, LinkedIn, Meet);
 *   2. the server's own MCP annotation (readOnlyHint), for hosted servers we do not
 *      control, and only when it says read-only — destructiveHint or a missing hint
 *      never makes a tool a read;
 *   3. a conservative name heuristic for hosted servers that send no annotations.
 */
export type ToolKind = 'read' | 'write'

export interface ToolAnnotationsLike {
	readOnlyHint?: boolean
	destructiveHint?: boolean
}

/** Read tools per provider. Everything registered by a provider but not listed here is a write. */
const READ_TOOLS: Record<string, ReadonlySet<string>> = {
	slack: new Set([
		'slack_list_channels',
		'slack_list_users',
		'slack_get_permalink',
		'slack_get_channel_history',
		'slack_get_thread_replies',
		'slack_conversations_info',
	]),
	'google-meet': new Set([
		'google_meet__list_conference_records',
		'google_meet__get_conference_record',
		'google_meet__list_participants',
		'google_meet__get_transcript_entries',
		'google_meet__list_recordings',
	]),
	// Matched on the verb: LinkedIn tool names carry a per-identity prefix.
	'linkedin-unipile': new Set([
		'read_post_comments',
		'get_post_engagement',
		'list_conversations',
		'list_messages',
		'list_connections',
		'search_people',
		'get_profile',
	]),
}

/**
 * Providers whose every tool only reads. Their servers send no annotations and their tool
 * names are not read verbs (keyword_ideas, domain_overview), so without this a read-only
 * agent could never use them.
 */
const ALL_READ_PROVIDERS: ReadonlySet<string> = new Set(['ubersuggest'])

const READ_PREFIXES = [
	'get_',
	'list_',
	'search_',
	'read_',
	'fetch_',
	'find_',
	'query_',
	'describe_',
	'show_',
	'view_',
	'count_',
	'lookup_',
]

// Any of these anywhere in a name makes it a write, whatever it starts with
// ("get_or_create_label", "list_and_delete").
const WRITE_WORDS =
	/(^|[_\-.])(create|update|delete|remove|send|post|write|set|add|edit|merge|push|publish|reply|comment|invite|assign|archive|close|open|move|upload|approve|reject|cancel|submit|trigger|run|execute|revoke|grant|patch|put|insert|upsert|modify|rename|resolve|reopen|fork|star|unstar|follow|unfollow|subscribe|unsubscribe|react|join|leave|connect|disconnect)([_\-.]|$)/

/** Strips a fan-out prefix: `linkedin-acc-personal__publish_post` → `publish_post`. */
function verbOf(toolName: string): string {
	const i = toolName.lastIndexOf('__')
	return i === -1 ? toolName : toolName.slice(i + 2)
}

export function classifyTool(
	provider: string,
	toolName: string,
	annotations?: ToolAnnotationsLike | null,
): ToolKind {
	const curated = READ_TOOLS[provider]
	if (curated) {
		// Our own providers are fully curated: a tool outside the set is a write, and
		// no annotation or name can talk it into being a read.
		return curated.has(toolName) || curated.has(verbOf(toolName)) ? 'read' : 'write'
	}
	if (ALL_READ_PROVIDERS.has(provider)) return 'read'
	if (annotations?.destructiveHint === true) return 'write'
	if (annotations?.readOnlyHint === true) return 'read'
	const verb = verbOf(toolName).toLowerCase()
	if (WRITE_WORDS.test(verb)) return 'write'
	return READ_PREFIXES.some((p) => verb.startsWith(p)) ? 'read' : 'write'
}

// ── PostHog: one tool ("exec"), many commands ────────────────────────────

/** Added to the tool's description for an agent that can read but not write. */
export const POSTHOG_EXEC_READ_NOTE =
	'Read access: query and lookup commands run; create, update and delete commands are refused.'

/**
 * PostHog's hosted MCP serves one tool, "exec", that takes a command string. Strict equality
 * on both parts: "EXEC", "exec " or a tool of another provider named exec keep the name rules.
 */
export function isPosthogExec(provider: string, toolName: string): boolean {
	return provider === 'posthog' && toolName === 'exec'
}

export interface CallVerdict {
	kind: ToolKind
	/** PostHog exec: the inner tool name, when the command named a well-formed one. Never its input. */
	commandTool?: string
}

const POSTHOG_COMMAND_MAX_CHARS = 100_000
const COMMAND_SHAPE = /^([a-z]+)((?:[ \t].*)?)$/
const DISCOVERY_COMMANDS: ReadonlySet<string> = new Set([
	'help',
	'tools',
	'search',
	'info',
	'schema',
	'learn',
])
const DISCOVERY_TAIL = /^[A-Za-z0-9 \t-]*$/
const INNER_TOOL_NAME = /^[a-z0-9][a-z0-9-]*$/

// Tab (0x09) is allowed between tokens; newlines and every other control character
// (0x00-0x08, 0x0a-0x1f, 0x7f) are not. Checked by char code, since a regex with escaped
// control characters fails the lint rule noControlCharactersInRegex.
function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if ((code <= 0x1f && code !== 0x09) || code === 0x7f) return true
	}
	return false
}

// PostHog's own tool names, on top of WRITE_WORDS, for a name that is not in the curated set.
const POSTHOG_WRITE_WORDS =
	/(^|-)(reset|enable|disable|toggle|duplicate|copy|clone|import|export|regenerate|rotate|restart|pause|resume|launch|ship|end|stop|start|schedule|bulk|sync|backfill|mark|dismiss|snooze|save|feedback|activate|deactivate|rename)(-|$)/
const POSTHOG_READ_WORDS = new Set([
	'get',
	'list',
	'retrieve',
	'query',
	'search',
	'read',
	'describe',
	'count',
	'schema',
	'info',
	'results',
	'stats',
])

function posthogInnerToolKind(name: string): ToolKind {
	if (POSTHOG_NEVER_READ.has(name)) return 'write'
	// The curated set first: execute-sql and data-catalog-metric-run are reads that the
	// write words ("execute", "run") would refuse.
	if (POSTHOG_READ_TOOLS.has(name)) return 'read'
	if (WRITE_WORDS.test(name) || POSTHOG_WRITE_WORDS.test(name)) return 'write'
	return name.split('-').some((token) => POSTHOG_READ_WORDS.has(token)) ? 'read' : 'write'
}

/**
 * Judges one exec command. Fail-closed: anything that is not exactly a known shape is a
 * write. The command's JSON input is only parsed to prove it is one value (so nothing can be
 * chained after it); its contents are never inspected.
 */
function classifyPosthogCommand(command: unknown): CallVerdict {
	const refused: CallVerdict = { kind: 'write' }
	if (typeof command !== 'string') return refused
	if (command.length > POSTHOG_COMMAND_MAX_CHARS || hasControlChar(command)) return refused
	const shape = COMMAND_SHAPE.exec(command)
	if (!shape) return refused
	const word = shape[1] ?? ''
	const tail = shape[2] ?? ''

	if (DISCOVERY_COMMANDS.has(word)) {
		return DISCOVERY_TAIL.test(tail) ? { kind: 'read' } : refused
	}
	if (word !== 'call') return refused

	let rest = tail
	for (;;) {
		const token = /^[ \t]+(\S+)/.exec(rest)
		if (!token) return refused
		const text = token[1] ?? ''
		rest = rest.slice(token[0].length)
		if (text === '--json') continue
		// --confirm is PostHog's own mark for a destructive tool; any other flag is unknown.
		if (text.startsWith('--')) return refused
		if (!INNER_TOOL_NAME.test(text)) return refused
		const input = rest.trim()
		if (input !== '') {
			try {
				JSON.parse(input)
			} catch {
				return { kind: 'write', commandTool: text }
			}
		}
		return { kind: posthogInnerToolKind(text), commandTool: text }
	}
}

/**
 * Like classifyTool, but sees the call's arguments. Only PostHog exec has a verdict that
 * depends on them; everything else is classifyTool unchanged. The exec rule runs before the
 * annotation check, so a hint from upstream cannot make exec a read.
 */
export function classifyCall(
	provider: string,
	toolName: string,
	args: unknown,
	annotations?: ToolAnnotationsLike | null,
): CallVerdict {
	if (isPosthogExec(provider, toolName)) {
		const command =
			args && typeof args === 'object' && !Array.isArray(args)
				? (args as { command?: unknown }).command
				: undefined
		return classifyPosthogCommand(command)
	}
	return { kind: classifyTool(provider, toolName, annotations) }
}
