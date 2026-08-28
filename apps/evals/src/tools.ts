import type Anthropic from '@anthropic-ai/sdk'
import { zodToJsonSchema } from 'zod-to-json-schema'
// Imported from source, not from the package entry point. `@maskin/mcp`'s
// exports map resolves `default` to ./dist/index.js, so importing the package
// would silently evaluate the last build instead of the working tree - the
// stale-dist trap in .claude/rules/known-pitfalls.md. Evals must grade the
// tool descriptions as they are written right now.
import { tools } from '../../../packages/mcp/src/tools'

export type ToolName = keyof typeof tools

/**
 * The slice of the MCP surface these evals cover. Kept deliberately small:
 * every tool in this list is one the model must choose between under
 * realistic prompts, and every one added multiplies the tokens each case
 * costs (the whole set ships in the system-level `tools` array on every
 * request). Grow it when a tool starts getting mis-called in production,
 * not preemptively.
 */
export const COVERED_TOOLS = [
	'create_objects',
	'get_objects',
	'list_objects',
	'search_objects',
	'update_objects',
	'get_workspace_schema',
] as const satisfies readonly ToolName[]

/**
 * Every tool the MCP server ships.
 *
 * Used only by trajectory cases, and only because the agent they stand in for
 * has the same thing: Chief of Staff is wired to the whole Maskin MCP server
 * via PLATFORM_MCP_PRESET, not a curated subset. Choosing `create_loop` out of
 * six tools is a materially easier problem than choosing it out of all of them,
 * and the easier problem is not the one that fails in production.
 */
export const ALL_TOOLS = Object.keys(tools) as ToolName[]

/**
 * Render the real MCP tool definitions into Anthropic tool-use format.
 *
 * The point of the whole harness is that this is a *translation*, not a
 * re-declaration: the descriptions and schemas under test are the exact
 * strings `packages/mcp/src/tools.ts` ships to every MCP client. Editing a
 * description there changes what these evals measure, with no edit here.
 */
export function buildToolDefinitions(names: readonly ToolName[] = COVERED_TOOLS): Anthropic.Tool[] {
	return names.map((name) => {
		const def = tools[name]
		const schema = zodToJsonSchema(def.inputSchema, {
			// Anthropic's tool schemas have no document root to anchor $refs
			// against, so inline every subschema instead of emitting $ref.
			$refStrategy: 'none',
			target: 'jsonSchema7',
		}) as Record<string, unknown>
		// zodToJsonSchema stamps a $schema key that the API rejects as an
		// unknown field on the input schema object.
		const { $schema: _unusedSchemaKey, ...inputSchema } = schema
		return {
			name,
			description: def.description,
			input_schema: inputSchema as Anthropic.Tool['input_schema'],
		}
	})
}
