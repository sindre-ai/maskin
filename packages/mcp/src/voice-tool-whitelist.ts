/**
 * Voice v1 tool whitelist — the set of MCP tools a voice call is allowed to
 * proxy through the browser DataChannel → backend WS bridge, and the guardrails
 * bound to each write tool. Kept pure so it is importable from both the
 * dev-side session-mint route (which pins `session.tools` on the Realtime
 * session) and the WS proxy handler (which re-enforces before invoking the
 * tool). Read + write lists must match the Voice v1 tech spec §Tool + KB
 * parity with chat — expanding this list is deliberately out of scope for v1.
 */

export const VOICE_READ_TOOLS = Object.freeze([
	'search_objects',
	'get_objects',
	'list_objects',
	'get_comments',
	'list_actors',
	'list_relationships',
] as const)

export const VOICE_WRITE_TOOLS = Object.freeze(['create_comment', 'create_objects'] as const)

export const VOICE_ALLOWED_TOOLS = Object.freeze([
	...VOICE_READ_TOOLS,
	...VOICE_WRITE_TOOLS,
] as const)

export type VoiceAllowedTool = (typeof VOICE_ALLOWED_TOOLS)[number]

/**
 * Attention ≤ 3 cap on `create_comment` from voice — a hands-free call must not
 * post attention-4 or attention-5 comments, which reserve their slot on the
 * human's For You feed. Anything requiring that escalation belongs in a text
 * follow-up the human can review.
 */
export const VOICE_CREATE_COMMENT_MAX_ATTENTION = 3 as const

/**
 * Only `insight` and `task` are creatable from voice; every other type is
 * either shape-heavy enough to need a screen (bet, knowledge, meeting) or an
 * artefact the workspace triage rail creates from the two allowed types.
 */
export const VOICE_CREATE_OBJECTS_ALLOWED_TYPES = Object.freeze(['insight', 'task'] as const)

export type VoiceCreateObjectsAllowedType = (typeof VOICE_CREATE_OBJECTS_ALLOWED_TYPES)[number]

const readSet = new Set<string>(VOICE_READ_TOOLS)
const writeSet = new Set<string>(VOICE_WRITE_TOOLS)
const allowedSet = new Set<string>(VOICE_ALLOWED_TOOLS)
const createObjectsTypeSet = new Set<string>(VOICE_CREATE_OBJECTS_ALLOWED_TYPES)

export function isVoiceAllowedTool(name: string): name is VoiceAllowedTool {
	return allowedSet.has(name)
}

export function isVoiceReadTool(name: string): boolean {
	return readSet.has(name)
}

export function isVoiceWriteTool(name: string): boolean {
	return writeSet.has(name)
}

/**
 * Stable error codes surfaced back to the Realtime session as a
 * `function_call_output`. The agent uses these to verbalise a graceful failure
 * ("I can't do that on a voice call"), so keep them stable — they show up in
 * `voice_tool_call.error_code`.
 */
export const VOICE_TOOL_ERROR_CODES = Object.freeze({
	toolNotAllowed: 'voice_tool_not_allowed',
	attentionTooHigh: 'voice_attention_too_high',
	createObjectsTypeNotAllowed: 'voice_create_objects_type_not_allowed',
	invalidArguments: 'voice_invalid_arguments',
} as const)

export type VoiceToolErrorCode =
	(typeof VOICE_TOOL_ERROR_CODES)[keyof typeof VOICE_TOOL_ERROR_CODES]

export class VoiceToolNotAllowedError extends Error {
	readonly code: VoiceToolErrorCode
	constructor(code: VoiceToolErrorCode, message: string) {
		super(message)
		this.name = 'VoiceToolNotAllowedError'
		this.code = code
	}
}

export function assertVoiceToolAllowed(name: string): asserts name is VoiceAllowedTool {
	if (!allowedSet.has(name)) {
		throw new VoiceToolNotAllowedError(
			VOICE_TOOL_ERROR_CODES.toolNotAllowed,
			`Tool ${name} is not available on a voice call.`,
		)
	}
}

/**
 * Enforces the attention ≤ 3 cap on a `create_comment` argument bag. Missing
 * or non-numeric attention values pass — the field is optional server-side
 * and defaults to unset, so a voice call that leaves it off is legal.
 */
export function assertVoiceCreateCommentAttentionAllowed(args: unknown): void {
	if (args == null || typeof args !== 'object') return
	const attention = (args as { attention?: unknown }).attention
	if (typeof attention !== 'number') return
	if (attention > VOICE_CREATE_COMMENT_MAX_ATTENTION) {
		throw new VoiceToolNotAllowedError(
			VOICE_TOOL_ERROR_CODES.attentionTooHigh,
			`Voice-call comments are capped at attention ${VOICE_CREATE_COMMENT_MAX_ATTENTION}; got ${attention}.`,
		)
	}
}

/**
 * Enforces the `type ∈ {insight, task}` cap on a `create_objects` argument
 * bag. The MCP tool is shaped `{ workspace_id, nodes: [{ $id, type, ... }], edges }`
 * (see `create_objects` in ./tools.ts), so the types live on `nodes[]`.
 *
 * Fails closed: a bag with no readable `nodes` array, or a node without a
 * string `type`, is rejected rather than waved through. A guard that no-ops
 * on a shape it does not recognise is a guard that silently stops guarding
 * when the tool's input shape moves.
 */
export function assertVoiceCreateObjectsTypesAllowed(args: unknown): void {
	const allowed = [...VOICE_CREATE_OBJECTS_ALLOWED_TYPES].join(', ')
	const reject = (detail: string): never => {
		throw new VoiceToolNotAllowedError(
			VOICE_TOOL_ERROR_CODES.createObjectsTypeNotAllowed,
			`Voice-call create_objects only supports ${allowed}; ${detail}.`,
		)
	}
	const nodes =
		args != null && typeof args === 'object' ? (args as { nodes?: unknown }).nodes : null
	if (!Array.isArray(nodes) || nodes.length === 0) reject('no nodes to create were given')
	for (const node of nodes as unknown[]) {
		const type = node != null && typeof node === 'object' ? (node as { type?: unknown }).type : null
		if (typeof type !== 'string') reject('a node had no type')
		else if (!createObjectsTypeSet.has(type)) reject(`got ${type}`)
	}
}

/**
 * One-call gate: throws with the right code for the first rule this
 * (name, args) pair violates, or returns cleanly if the invocation is legal.
 * Callers use it once at the WS boundary before dispatching to `invokeTool`.
 */
export function assertVoiceInvocationAllowed(name: string, args: unknown): void {
	assertVoiceToolAllowed(name)
	if (name === 'create_comment') assertVoiceCreateCommentAttentionAllowed(args)
	if (name === 'create_objects') assertVoiceCreateObjectsTypesAllowed(args)
}
