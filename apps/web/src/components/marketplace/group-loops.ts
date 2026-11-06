import type { MarketplaceLoopSummary } from '@/lib/api'

export const OTHER_GROUP = 'Other'

export interface LoopGroup {
	name: string
	loops: MarketplaceLoopSummary[]
}

/** Groups flows by `use_case`: groups A→Z (locale-aware, case-insensitive,
 * numeric-aware), flows with no use case in a final "Other" group, and the
 * rows inside a group keep their incoming order. */
export function groupLoopsByUseCase(loops: MarketplaceLoopSummary[]): LoopGroup[] {
	const byName = new Map<string, MarketplaceLoopSummary[]>()
	const other: MarketplaceLoopSummary[] = []
	for (const loop of loops) {
		const name = loop.use_case?.trim()
		if (!name) {
			other.push(loop)
			continue
		}
		const list = byName.get(name) ?? []
		list.push(loop)
		byName.set(name, list)
	}
	const groups = [...byName.entries()]
		.map(([name, list]) => ({ name, loops: list }))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
	if (other.length > 0) groups.push({ name: OTHER_GROUP, loops: other })
	return groups
}
