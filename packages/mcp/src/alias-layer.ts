import { z } from 'zod'
import { type AliasRow, JSON_ARRAY_KEYS, aliasRowsFor } from './aliases.js'

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
	opts: { rows?: readonly AliasRow[] } = {},
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

	result.args = parseJsonArrayStrings(tool, args)
	return result
}

// A string under a list-valued key is parsed once when it holds a JSON array.
function parseJsonArrayStrings(tool: string, args: unknown): unknown {
	const keys = JSON_ARRAY_KEYS[tool]
	if (!keys || !isPlainObject(args)) return args
	let out: Record<string, unknown> = args
	for (const key of keys) {
		const value = out[key]
		if (typeof value !== 'string' || !value.trimStart().startsWith('[')) continue
		try {
			const parsed: unknown = JSON.parse(value)
			if (Array.isArray(parsed)) out = { ...out, [key]: parsed }
		} catch {
			// Not JSON: leave the string for the schema to reject.
		}
	}
	return out
}

/** True when a tool needs the normalise step at all. */
export function needsNormalise(tool: string): boolean {
	return aliasRowsFor(tool).length > 0 || tool in JSON_ARRAY_KEYS
}

/**
 * Wraps a tool's input as z.preprocess(normalise, schema). The input is either a raw shape (wrapped
 * in z.object) or a schema object, such as list_triggers' strict one, which is wrapped as it is so
 * its strictness survives. Either way the rename runs first: the MCP SDK validates arguments
 * against this schema before our handler runs, so the old spellings are gone by the time anything
 * else, the strict unknown-parameter check included, sees the call.
 *
 * The canonical shape is also set on the wrapper. The SDK builds tools/list from a schema's .shape,
 * and a bare preprocess wrapper has none, which would list every wrapped tool with an empty
 * parameter list.
 *
 * With rejectUnknownKeys, a top-level key outside the shape fails validation (after the old
 * spellings are normalised) instead of being stripped. Opt in per tool: z.object drops unknown keys
 * before the handler runs, so the handler cannot see a misnamed list, and a call mixing one valid
 * list with one misnamed list would otherwise look like a full success.
 */
export function wrapInputSchema(
	input: z.ZodRawShape | z.ZodObject<z.ZodRawShape>,
	normalise: (raw: unknown) => unknown,
	opts: {
		rejectUnknownKeys?: boolean
		/** Closes the unknown-key refusal. Defaults to the write tools' "Nothing was written." */
		unknownKeysSuffix?: string
		explain?: (args: unknown) => string | null
		/** Misspelling -> accepted name, shown beside the unknown name in the error. */
		hints?: Readonly<Record<string, string>>
		/** At least one of these names must be sent, or the call fails instead of listing everything. */
		requireOneOf?: readonly string[]
	} = {},
): z.ZodTypeAny {
	const schema = input instanceof z.ZodType ? input : z.object(input)
	const shape = input instanceof z.ZodType ? input.shape : input
	const wrapped = z.preprocess((raw, ctx) => {
		const args = normalise(raw)
		if (opts.rejectUnknownKeys && isPlainObject(args)) {
			const accepted = Object.keys(shape)
			const unknown = Object.keys(args).filter((key) => !accepted.includes(key))
			if (unknown.length > 0) {
				const named = unknown.map((key) =>
					opts.hints?.[key] ? `${key} (use ${opts.hints[key]})` : key,
				)
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						`Unrecognised argument name${unknown.length > 1 ? 's' : ''}: ${named.join(', ')}. Accepted names: ${accepted.join(', ')}. ${opts.unknownKeysSuffix ?? 'Nothing was written.'}`.trimEnd(),
				})
			}
		}
		const required = opts.requireOneOf
		if (required?.length && isPlainObject(args)) {
			if (!required.some((key) => (args as Record<string, unknown>)[key] !== undefined)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Pass at least one of: ${required.join(', ')}. With none of them the call would list the whole workspace.`,
				})
			}
		}
		const explained = opts.explain?.(args)
		if (explained) ctx.addIssue({ code: z.ZodIssueCode.custom, message: explained })
		return args
	}, schema)
	return Object.assign(wrapped, { shape })
}
