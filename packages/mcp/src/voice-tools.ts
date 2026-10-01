/**
 * Voice v1 tool surface: the JSON-schema definitions pinned onto the OpenAI
 * Realtime session at mint (`session.tools`), and the argument gate the WS
 * tool-proxy runs before dispatching to `invokeTool`.
 *
 * The advertised schemas are deliberately narrower than the MCP tools' own
 * input schemas — a voice model gets the few fields a spoken request needs,
 * not the whole surface. The real zod schema in ./tools.ts stays the authority:
 * `parseVoiceToolArgs` validates against it, so a field the model invents or
 * gets wrong is rejected the same way a chat agent's would be.
 */

import type { ZodTypeAny } from 'zod'
import { tools } from './tools.js'
import {
	VOICE_TOOL_ERROR_CODES,
	type VoiceAllowedTool,
	VoiceToolNotAllowedError,
	assertVoiceInvocationAllowed,
} from './voice-tool-whitelist.js'

export interface VoiceRealtimeTool {
	type: 'function'
	name: VoiceAllowedTool
	description: string
	parameters: {
		type: 'object'
		properties: Record<string, unknown>
		required?: string[]
	}
}

const uuid = { type: 'string', format: 'uuid' } as const
const limit = { type: 'integer', minimum: 1, maximum: 25 } as const

export const VOICE_REALTIME_TOOLS: readonly VoiceRealtimeTool[] = Object.freeze([
	{
		type: 'function',
		name: 'search_objects',
		description:
			'Search the workspace for bets, tasks, insights and other objects by keywords in the title or content. Use this when the person names something to find.',
		parameters: {
			type: 'object',
			properties: {
				q: { type: 'string', description: 'Keywords to search for.' },
				type: { type: 'string', description: 'Optional object type, e.g. bet, task, insight.' },
				status: { type: 'string', description: 'Optional status filter.' },
				limit,
			},
			required: ['q'],
		},
	},
	{
		type: 'function',
		name: 'get_objects',
		description: 'Read one or more objects by id. Ask for content to get the full body.',
		parameters: {
			type: 'object',
			properties: {
				ids: { type: 'array', items: uuid, minItems: 1, maxItems: 10 },
				include: {
					type: 'array',
					items: { type: 'string', enum: ['content', 'metadata', 'relationships'] },
				},
			},
			required: ['ids'],
		},
	},
	{
		type: 'function',
		name: 'list_objects',
		description:
			'List objects of a type, newest first. Use it for questions like "what tasks are in review".',
		parameters: {
			type: 'object',
			properties: {
				type: { type: 'string' },
				status: { type: 'string' },
				sort: { type: 'string', enum: ['updated_at_asc', 'updated_at_desc'] },
				limit,
			},
		},
	},
	{
		type: 'function',
		name: 'get_comments',
		description: 'Read the comments on an object.',
		parameters: {
			type: 'object',
			properties: { entity_id: uuid, limit },
			required: ['entity_id'],
		},
	},
	{
		type: 'function',
		name: 'list_actors',
		description: 'List the humans and agents in the workspace.',
		parameters: { type: 'object', properties: { limit } },
	},
	{
		type: 'function',
		name: 'list_relationships',
		description: 'List the links from and to an object.',
		parameters: {
			type: 'object',
			properties: { object_id: uuid, type: { type: 'string' }, limit },
		},
	},
	{
		type: 'function',
		name: 'create_comment',
		description:
			'Post a comment on an object. Attention is capped at 3 on a voice call; higher values are refused.',
		parameters: {
			type: 'object',
			properties: {
				entity_id: uuid,
				content: { type: 'string', description: 'The comment, one short conversational thought.' },
				attention: { type: 'integer', minimum: 1, maximum: 3 },
			},
			required: ['entity_id', 'content'],
		},
	},
	{
		type: 'function',
		name: 'create_objects',
		description:
			'Capture an insight or a task. Only the insight and task types can be created on a voice call.',
		parameters: {
			type: 'object',
			properties: {
				nodes: {
					type: 'array',
					minItems: 1,
					maxItems: 5,
					items: {
						type: 'object',
						properties: {
							$id: { type: 'string', description: 'A short local label, unique within this call.' },
							type: { type: 'string', enum: ['insight', 'task'] },
							title: { type: 'string' },
							content: { type: 'string' },
							status: {
								type: 'string',
								description: 'Entry status for the type: new for an insight, backlog for a task.',
							},
						},
						required: ['$id', 'type', 'title', 'status'],
					},
				},
			},
			required: ['nodes'],
		},
	},
]) as readonly VoiceRealtimeTool[]

/**
 * Validate and normalise a voice tool call's arguments.
 *
 * - Rejects anything off the whitelist, over the attention cap, or creating a
 *   non-{insight, task} type (codes in `VOICE_TOOL_ERROR_CODES`).
 * - Forces `workspace_id` to the voice session's workspace. The agent's API key
 *   may be a member of other workspaces, and a model steered by retrieved text
 *   must not be able to read or write across them by passing another id.
 * - Validates against the MCP tool's real zod schema, since `invokeTool`
 *   dispatches straight to the handler and skips the SDK's input parsing.
 *
 * The whitelist gate runs on the raw args first (so a rule violation reports
 * its own code, not a generic schema error) and again on the parsed args.
 */
export function parseVoiceToolArgs(
	name: string,
	rawArgs: unknown,
	workspaceId: string,
): Record<string, unknown> {
	if (rawArgs == null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
		throw new VoiceToolNotAllowedError(
			VOICE_TOOL_ERROR_CODES.invalidArguments,
			`Arguments for ${name} must be a JSON object.`,
		)
	}
	assertVoiceInvocationAllowed(name, rawArgs)
	const schema = (tools as Record<string, { inputSchema: ZodTypeAny }>)[name]?.inputSchema
	const parsed = schema?.safeParse({ ...(rawArgs as object), workspace_id: workspaceId })
	if (!parsed?.success) {
		const detail = parsed?.error.issues
			.slice(0, 3)
			.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
			.join('; ')
		throw new VoiceToolNotAllowedError(
			VOICE_TOOL_ERROR_CODES.invalidArguments,
			`Invalid arguments for ${name}${detail ? ` (${detail})` : ''}.`,
		)
	}
	assertVoiceInvocationAllowed(name, parsed.data)
	return parsed.data as Record<string, unknown>
}
