/**
 * Tools whose full definitions the client loads at session start.
 *
 * Claude Code defers MCP tool definitions until a tool is searched for. An agent that skips the
 * search calls a tool blind and guesses its parameter names. A tool that sets
 * `_meta["anthropic/alwaysLoad"]` to true is loaded up front instead. The client reads the mark
 * when it connects. Clients that do not know the key ignore it.
 *
 * These ten are the daily tools. Together their definitions are about 12,000 tokens in every
 * session, so grow this set on purpose: always-load-tools.test.ts caps the total at 15,000 tokens.
 */
export const ALWAYS_LOAD_META_KEY = 'anthropic/alwaysLoad'

export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
	'get_objects',
	'list_objects',
	'create_objects',
	'update_objects',
	'get_comments',
	'create_comment',
	'list_relationships',
	'update_notification',
	'list_sessions',
	'list_actors',
])
