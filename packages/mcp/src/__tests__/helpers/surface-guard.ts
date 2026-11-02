import type { AliasRow } from '../../aliases'
import type { RemovalEntry } from '../../removal-ledger'

// tool name -> every parameter path the tool advertises, dotted, array indexes
// dropped (edges.source, updates.id). Container paths are included, so an
// object parameter and each of its fields are separate entries.
export type SurfaceMap = Record<string, string[]>

export function collectParamPaths(inputSchema: unknown): string[] {
	const out = new Set<string>()
	const walk = (node: unknown, prefix: string) => {
		if (!node || typeof node !== 'object') return
		const schema = node as Record<string, unknown>
		const props = schema.properties
		if (props && typeof props === 'object') {
			for (const [key, child] of Object.entries(props)) {
				const path = prefix ? `${prefix}.${key}` : key
				out.add(path)
				walk(child, path)
			}
		}
		walk(schema.items, prefix)
		for (const k of ['anyOf', 'oneOf', 'allOf']) {
			const branches = schema[k]
			if (Array.isArray(branches)) for (const b of branches) walk(b, prefix)
		}
		if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
			walk(schema.additionalProperties, prefix)
		}
	}
	walk(inputSchema, '')
	return [...out].sort()
}

export function buildSurface(
	listed: ReadonlyArray<{ name: string; inputSchema: unknown }>,
): SurfaceMap {
	const surface: SurfaceMap = {}
	for (const tool of [...listed].sort((a, b) => a.name.localeCompare(b.name))) {
		surface[tool.name] = collectParamPaths(tool.inputSchema)
	}
	return surface
}

const covers = (covering: string, path: string) =>
	path === covering || path.startsWith(`${covering}.`)

/**
 * Every entry in `snapshot` that is gone from `current` and not covered by a
 * live alias row (old path) or a ledger entry. Empty means the guard passes.
 */
export function findUncoveredRemovals(
	snapshot: SurfaceMap,
	current: SurfaceMap,
	aliases: readonly AliasRow[],
	ledger: readonly RemovalEntry[],
): string[] {
	const problems: string[] = []
	for (const [tool, paths] of Object.entries(snapshot)) {
		const now = current[tool]
		if (!now) {
			if (!ledger.some((e) => e.tool === tool && e.path === undefined)) {
				problems.push(`tool ${tool} is gone and has no removal ledger entry`)
			}
			continue
		}
		const have = new Set(now)
		for (const path of paths) {
			if (have.has(path)) continue
			const aliased = aliases.some((a) => a.tool === tool && covers(a.oldPath, path))
			const ledgered = ledger.some(
				(e) => e.tool === tool && e.path !== undefined && covers(e.path, path),
			)
			if (!aliased && !ledgered) {
				problems.push(`${tool} parameter ${path} is gone with no live alias row or ledger entry`)
			}
		}
	}
	return problems
}
