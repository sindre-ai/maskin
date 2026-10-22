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
	'google-search-console': new Set(['inspect_url', 'list_sites']),
	// Matched on the verb: LinkedIn tool names carry a per-identity prefix.
	'linkedin-unipile': new Set([
		'read_post_comments',
		'get_post_engagement',
		'list_conversations',
		'list_messages',
		'list_connections',
		'search_people',
		'get_profile',
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
