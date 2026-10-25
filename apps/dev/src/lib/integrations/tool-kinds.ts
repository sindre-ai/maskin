/**
 * Whether an integration tool only reads or can change something. The gate in
 * tool-gate.ts uses this to decide which tools a read-only agent may call.
 *
 * Fail-closed: a tool nobody classified is a write. A wrong "write" costs a refused
 * call and an obvious message; a wrong "read" lets an agent take an action it was
 * never allowed to.
 *
 * Order of evidence, strongest first:
 *   1. the curated sets below, for tools we register ourselves (Slack, LinkedIn, Meet,
 *      Search Console);
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
	'google-search-console': new Set(['inspect_url', 'list_sites', 'list_sitemaps', 'get_sitemap']),
	// Matched on the verb: LinkedIn tool names carry a per-identity prefix.
	'linkedin-unipile': new Set([
		'read_post_comments',
		'get_post_engagement',
		'list_conversations',
		'list_messages',
		'list_connections',
		'search_people',
		'get_profile',
		// Outreach reads. The writes beside them (withdraw_invitation, react_to_post,
		// send_inmail) are deliberately absent: outside this set a tool is a write.
		'list_sent_invitations',
		'list_user_posts',
		'get_company',
		'get_inmail_balance',
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

// ── PostHog exec ─────────────────────────────────────────────────────────

/**
 * PostHog's hosted MCP serves one tool, `exec`, that takes a CLI-style command. Its name
 * says nothing, so classifying the name alone refuses every Read agent. The read/write
 * decision lives in the command, so this one tool is judged per call. Exact match on
 * both parts: no trimming, no case folding, no other provider, no other tool name.
 */
export function isCommandGated(provider: string, toolName: string): boolean {
	return provider === 'posthog' && toolName === 'exec'
}

export interface CallVerdict {
	kind: ToolKind
	/** The inner tool of a `call`, once its name parsed. Never the json input. */
	innerTool?: string
}

const EXEC_MAX_COMMAND_CHARS = 100_000
const EXEC_DISCOVERY = new Set(['help', 'tools', 'search', 'info', 'schema', 'learn'])
const EXEC_DISCOVERY_TAIL = /^[A-Za-z0-9 -]*$/
// Control characters other than tab, plus the Unicode line separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const EXEC_FORBIDDEN_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/
const EXEC_TOOL_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Inner PostHog tools that read although a write word is in their name ("execute", "run"),
 * checked before the token rules. Exact names from PostHog's own tool list, never a prefix.
 * Without these the main read path (SQL, dashboards) would be refused as a write.
 */
const POSTHOG_READ_TOOLS: ReadonlySet<string> = new Set([
	'execute-sql',
	'data-catalog-metric-run',
	'dashboard-insights-run',
	'dashboard-widgets-run',
])

/** Named like a read, but PostHog does not mark it read-only (it starts a generation job). */
const POSTHOG_WRITE_TOOLS: ReadonlySet<string> = new Set(['workflows-data-suggestions-list'])

const POSTHOG_READ_TOKENS: ReadonlySet<string> = new Set([
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

// PostHog's own mutating words, on top of WRITE_WORDS.
const POSTHOG_WRITE_TOKENS: ReadonlySet<string> = new Set([
	'reset',
	'enable',
	'disable',
	'toggle',
	'duplicate',
	'copy',
	'clone',
	'import',
	'export',
	'regenerate',
	'rotate',
	'restart',
	'pause',
	'resume',
	'launch',
	'ship',
	'end',
	'stop',
	'start',
	'schedule',
	'bulk',
	'sync',
	'backfill',
	'mark',
	'dismiss',
	'snooze',
	'save',
	'feedback',
	'activate',
	'deactivate',
	'rename',
])

/** Verdict for one inner PostHog tool name: the curated sets, then the token rules. */
export function classifyPosthogInnerTool(name: string): ToolKind {
	if (POSTHOG_WRITE_TOOLS.has(name)) return 'write'
	if (POSTHOG_READ_TOOLS.has(name)) return 'read'
	const tokens = name.split('-')
	if (tokens.some((t) => POSTHOG_WRITE_TOKENS.has(t) || WRITE_WORDS.test(t))) return 'write'
	return tokens.some((t) => POSTHOG_READ_TOKENS.has(t)) ? 'read' : 'write'
}

/** True when the whole text parses as exactly one JSON value. */
function isOneJsonValue(text: string): boolean {
	try {
		JSON.parse(text)
		return true
	} catch {
		return false
	}
}

/**
 * Judges the `command` of a PostHog exec call. Fail closed: anything that does not match
 * the grammar exactly is a write. Case sensitive.
 *   - discovery (help, tools, search, info, schema, learn): letters, digits, spaces and
 *     hyphens only after the command word;
 *   - call [--json] <tool> [one JSON value]: --confirm or any other flag is a write, and
 *     so is anything after the tool name that is not exactly one JSON value, which is
 *     what closes "call a {} ; call b {}".
 * The json input is parsed to prove it is one value and is never inspected.
 */
export function classifyPosthogCommand(command: unknown): CallVerdict {
	const refused: CallVerdict = { kind: 'write' }
	if (typeof command !== 'string') return refused
	if (command.length > EXEC_MAX_COMMAND_CHARS || EXEC_FORBIDDEN_CHARS.test(command)) return refused
	const word = /^[a-z]+/.exec(command)?.[0]
	if (!word) return refused
	const rest = command.slice(word.length)
	if (EXEC_DISCOVERY.has(word)) {
		return EXEC_DISCOVERY_TAIL.test(rest) ? { kind: 'read' } : refused
	}
	if (word !== 'call') return refused

	let tail = rest
	for (;;) {
		const m = /^[ \t]+(\S+)/.exec(tail)
		const name = m?.[1]
		if (!m || name === undefined) return refused
		tail = tail.slice(m[0].length)
		if (name === '--json') continue
		if (!EXEC_TOOL_NAME.test(name)) return refused
		const innerTool = name.slice(0, 100)
		const input = tail.replace(/^[ \t]+|[ \t]+$/g, '')
		if (input !== '' && !isOneJsonValue(input)) return { kind: 'write', innerTool }
		return { kind: classifyPosthogInnerTool(name), innerTool }
	}
}

/**
 * Like classifyTool, for a call whose arguments decide the verdict. Only PostHog exec is
 * judged by its command, and before any annotation, so a hint from the server cannot make
 * it a read. Every other provider and tool name is classifyTool, unchanged.
 */
export function classifyCall(
	provider: string,
	toolName: string,
	args: unknown,
	annotations?: ToolAnnotationsLike | null,
): CallVerdict {
	if (!isCommandGated(provider, toolName)) {
		return { kind: classifyTool(provider, toolName, annotations) }
	}
	const command =
		args && typeof args === 'object' ? (args as { command?: unknown }).command : undefined
	return classifyPosthogCommand(command)
}
