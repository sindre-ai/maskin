import { z } from 'zod'
import { type AliasRow, DEFAULT_WORKSPACE_TOOLS, aliasRowsFor } from './aliases.js'

export interface AppliedRename {
	/** Dotted path of the old spelling, array indexes dropped. */
	old: string
	/** Dotted path of the canonical spelling. */
	new: string
}

export interface NormaliseResult {
	args: unknown
	/** Every old spelling found in the call, once per path. */
	renames: AppliedRename[]
	/** True when a call sent both the old and the new spelling of the same key. */
	bothSent: boolean
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v)

// Applies one row to `node`, which is the value found at `parentPath`. Walks
// `rest` (the remaining parent segments) first: an array fans out to each
// element, an object descends. Containers on the way are copied, never mutated,
// so the caller's arguments object is left alone.
function applyRow(
	node: unknown,
	rest: string[],
	oldKey: string,
	newKey: string,
	wrap: boolean,
	hits: { found: boolean; bothSent: boolean },
): unknown {
	if (Array.isArray(node)) {
		return node.map((el) => applyRow(el, rest, oldKey, newKey, wrap, hits))
	}
	if (!isPlainObject(node)) return node

	if (rest.length > 0) {
		const [head, ...tail] = rest as [string, ...string[]]
		if (!(head in node)) return node
		return { ...node, [head]: applyRow(node[head], tail, oldKey, newKey, wrap, hits) }
	}

	if (!(oldKey in node)) return node
	hits.found = true
	const { [oldKey]: oldValue, ...without } = node
	// Both spellings sent: the new one wins and the old one is dropped.
	if (newKey in node && node[newKey] !== undefined) {
		hits.bothSent = true
		return without
	}
	return { ...without, [newKey]: wrap && !Array.isArray(oldValue) ? [oldValue] : oldValue }
}

/**
 * Turns the old spellings in a tool call's arguments into the canonical ones.
 * Pure: no telemetry, no I/O. Unknown keys are left alone (the schema strips
 * them, as it does today). Returns the renames it saw so a later task can
 * report them.
 */
export function normaliseArgs(
	tool: string,
	raw: unknown,
	opts: { defaultWorkspaceId?: string; rows?: readonly AliasRow[] } = {},
): NormaliseResult {
	const result: NormaliseResult = { args: raw, renames: [], bothSent: false }
	if (!isPlainObject(raw)) return result

	let args: unknown = raw
	const seen = new Set<string>()
	for (const row of opts.rows ?? aliasRowsFor(tool)) {
		const oldSegments = row.oldPath.split('.')
		const newSegments = row.newPath.split('.')
		const oldKey = oldSegments[oldSegments.length - 1] as string
		const newKey = newSegments[newSegments.length - 1] as string
		const parent = oldSegments.slice(0, -1)
		const hits = { found: false, bothSent: false }
		args = applyRow(args, parent, oldKey, newKey, row.kind === 'wrap', hits)
		if (hits.found && !seen.has(row.oldPath)) {
			seen.add(row.oldPath)
			result.renames.push({ old: row.oldPath, new: row.newPath })
		}
		if (hits.bothSent) result.bothSent = true
	}

	if (
		DEFAULT_WORKSPACE_TOOLS.has(tool) &&
		opts.defaultWorkspaceId &&
		isPlainObject(args) &&
		args.workspace_id === undefined
	) {
		args = { ...args, workspace_id: opts.defaultWorkspaceId }
	}

	result.args = args
	return result
}

/** True when a tool needs the normalise step at all. */
export function needsNormalise(tool: string): boolean {
	return aliasRowsFor(tool).length > 0 || DEFAULT_WORKSPACE_TOOLS.has(tool)
}

/**
 * Wraps a tool's raw input shape as z.preprocess(normalise, z.object(shape)).
 * The MCP SDK validates arguments against this schema before our handler runs,
 * so the old spellings are gone by the time anything else sees the call.
 *
 * The canonical shape is also set on the wrapper. The SDK builds tools/list
 * from a schema's .shape, and a bare preprocess wrapper has none, which would
 * list every wrapped tool with an empty parameter list.
 */
export function wrapInputSchema(
	shape: z.ZodRawShape,
	normalise: (raw: unknown) => unknown,
): z.ZodTypeAny {
	const wrapped = z.preprocess(normalise, z.object(shape))
	return Object.assign(wrapped, { shape })
}
