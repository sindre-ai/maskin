import { createHash } from 'node:crypto'

/**
 * Canonical form of a tool input schema: object keys sorted, every JSON-Schema
 * description removed. Copy edits are not capability changes; an added or
 * renamed parameter is.
 *
 * Only a string-valued "description" key is stripped. A tool parameter that is
 * itself called "description" is an object under "properties" and must stay, or
 * adding it would be invisible.
 */
export function canonicalizeSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeSchema)
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key]
			if (key === 'description' && typeof child === 'string') continue
			out[key] = canonicalizeSchema(child)
		}
		return out
	}
	return value
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

/** Hash of a tool's input schema. Only the hash is ever stored, never the schema. */
export function hashToolSchema(inputSchema: unknown): string {
	return sha256(JSON.stringify(canonicalizeSchema(inputSchema ?? null)))
}

/** Hash of a stdio server spec (command plus args, where a pinned version shows up). */
export function hashServerSpec(spec: { command: string; args: readonly string[] }): string {
	return sha256(JSON.stringify([spec.command, [...spec.args]]))
}
