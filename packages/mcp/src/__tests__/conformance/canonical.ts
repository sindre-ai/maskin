// Canonical JSON and the per-tool digest used to compare tools/list across
// eras, builds and restarts without checking a 130 KB golden file in twice.

import { createHash } from 'node:crypto'

/** JSON with object keys sorted recursively, so key order never shows up as a diff. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeys((value as Record<string, unknown>)[key])
		}
		return out
	}
	return value
}

/** Drop every "$schema" key. The SDK swap is allowed to change the schema dialect URI and nothing else. */
export function stripSchemaUri(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSchemaUri)
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			if (key !== '$schema') out[key] = stripSchemaUri(inner)
		}
		return out
	}
	return value
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

export interface ToolListing {
	name: string
	[key: string]: unknown
}

/** One digest per tool: names, descriptions, annotations, _meta and inputSchema all count. */
export function toolDigests(tools: ToolListing[]): Array<{ name: string; digest: string }> {
	return tools.map((tool) => ({
		name: tool.name,
		digest: sha256(canonicalJson(stripSchemaUri(tool))),
	}))
}

/** Digest of the whole listing, in listed order (the order is part of the contract). */
export function listingDigest(tools: ToolListing[]): string {
	return sha256(JSON.stringify(toolDigests(tools)))
}
