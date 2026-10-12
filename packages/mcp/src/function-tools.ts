import type { ZodTypeAny } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { LIVE_EXCLUDED_TOOLS } from './tool-risk.js'
import { tools } from './tools.js'

/** One OpenAI-style function tool, as sent in a chat completion's `tools`. */
export interface LiveFunctionTool {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

const MAX_DESCRIPTION_CHARS = 1024

type ToolEntry = { description?: string; inputSchema?: ZodTypeAny }

function describe(text: string | undefined): string {
	const t = (text ?? '').replace(/\s+/g, ' ').trim()
	return t.length > MAX_DESCRIPTION_CHARS ? `${t.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : t
}

/**
 * Builds the function tools a live call advertises, straight from the MCP
 * tool catalogue so chat and live never drift. `workspace_id` is removed from
 * every schema: a live call is bound to one workspace and the server forces it,
 * so the model neither sees nor can change it.
 */
export function buildLiveFunctionTools(
	exclude: ReadonlySet<string> = LIVE_EXCLUDED_TOOLS,
): LiveFunctionTool[] {
	const out: LiveFunctionTool[] = []
	for (const [name, entry] of Object.entries(tools as Record<string, ToolEntry>)) {
		if (exclude.has(name) || !entry.inputSchema) continue
		const raw = zodToJsonSchema(entry.inputSchema, {
			target: 'openApi3',
			$refStrategy: 'none',
		}) as Record<string, unknown>
		out.push({
			type: 'function',
			function: {
				name,
				description: describe(entry.description),
				parameters: withoutWorkspaceId(raw),
			},
		})
	}
	return out
}

/** Drops `workspace_id` from a JSON schema's properties and required list, leaving the input untouched. */
function withoutWorkspaceId(schema: Record<string, unknown>): Record<string, unknown> {
	const { properties, required, ...rest } = schema
	const out: Record<string, unknown> = { ...rest }
	if (properties && typeof properties === 'object') {
		const { workspace_id: _workspaceId, ...kept } = properties as Record<string, unknown>
		out.properties = kept
	}
	if (Array.isArray(required)) {
		const kept = (required as string[]).filter((r) => r !== 'workspace_id')
		if (kept.length > 0) out.required = kept
	}
	return out
}

export class LiveToolArgsError extends Error {
	readonly toolName: string
	constructor(toolName: string, message: string) {
		super(message)
		this.name = 'LiveToolArgsError'
		this.toolName = toolName
	}
}

/**
 * Validates a model-supplied argument bag against the tool's real zod schema
 * and pins `workspace_id`. `invokeTool` dispatches straight to the handler and
 * skips the SDK's own input parsing, so this is the only gate between a model
 * and the handler: a field it invents or gets wrong is rejected as a chat
 * agent's would be, and a model steered by retrieved text cannot reach another
 * workspace by passing a different id.
 */
export function parseLiveToolArgs(
	name: string,
	rawArgs: unknown,
	workspaceId: string,
): Record<string, unknown> {
	if (rawArgs == null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
		throw new LiveToolArgsError(name, `Arguments for ${name} must be a JSON object.`)
	}
	const entry = (tools as Record<string, ToolEntry>)[name]
	if (!entry?.inputSchema) throw new LiveToolArgsError(name, `Unknown tool ${name}.`)
	const parsed = entry.inputSchema.safeParse({ ...(rawArgs as object), workspace_id: workspaceId })
	if (!parsed.success) {
		const detail = parsed.error.issues
			.slice(0, 3)
			.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
			.join('; ')
		throw new LiveToolArgsError(
			name,
			`Invalid arguments for ${name}${detail ? ` (${detail})` : ''}.`,
		)
	}
	return parsed.data as Record<string, unknown>
}
