// The chip rows under the search field: which chips to show and what count each
// carries. Counts come from the search endpoint (true totals), never from the rows
// on screen. A chip with no hits is hidden unless it is selected, so a quiet group
// like "Needs you" never looks broken. Before the first answer the counts are null
// and the chips show a dash instead of a misleading 0. A group whose source failed
// keeps its chip with a dash, so a failed source never reads as "nothing matches".

import { STATUS_GROUPS, STATUS_GROUP_LABELS, type StatusGroup } from './vocabulary'

export interface TypeOption {
	key: string
	label: string
}

export interface TypeChip {
	key: string
	label: string
	/** Null until the first answer arrives. */
	count: number | null
	selected: boolean
}

export interface StatusChip {
	key: StatusGroup
	label: string
	count: number | null
	selected: boolean
}

// The search source behind each fixed type chip. The objects source feeds every other chip.
const SOURCE_TYPE_KEY: Record<string, string> = {
	chats: 'chat',
	loops: 'loop',
	agents: 'agent',
	people: 'person',
	automations: 'automation',
}

/** The type chips whose counts are missing because their source failed. */
export function failedTypeKeys(partial: readonly string[], allKeys: readonly string[]): string[] {
	const own = new Set(Object.values(SOURCE_TYPE_KEY))
	const failed = partial.flatMap((source) => {
		const key = SOURCE_TYPE_KEY[source]
		if (key) return [key]
		return source === 'objects' ? allKeys.filter((k) => !own.has(k)) : []
	})
	return [...new Set(failed)]
}

export function buildTypeChips(input: {
	/** Every type the workspace can search, in display order. */
	options: TypeOption[]
	/** Per type key; text match only. Null before the first answer. */
	counts: Record<string, number> | null
	selected: string[]
	/** Display name for a type the endpoint returned that the workspace list lacks. */
	fallbackLabel: (key: string) => string
	/** Type keys whose source failed: the chip stays, with a dash instead of a count. */
	failed?: string[]
}): TypeChip[] {
	const { options, counts, selected, fallbackLabel, failed = [] } = input
	const known = new Set(options.map((o) => o.key))
	const all: TypeOption[] = [...options]
	// A selected pill, or a count for a type missing from the list, still gets a chip.
	for (const key of [...selected, ...Object.keys(counts ?? {})]) {
		if (!known.has(key)) {
			known.add(key)
			all.push({ key, label: fallbackLabel(key) })
		}
	}
	return all
		.map((o) => ({
			key: o.key,
			label: o.label,
			count: counts && !failed.includes(o.key) ? (counts[o.key] ?? 0) : null,
			selected: selected.includes(o.key),
		}))
		.filter((chip) => chip.selected || chip.count === null || chip.count > 0)
}

export function buildStatusChips(input: {
	counts: Record<StatusGroup, number> | null
	selected: string[]
}): StatusChip[] {
	const { counts, selected } = input
	return STATUS_GROUPS.map((key) => ({
		key,
		label: STATUS_GROUP_LABELS[key],
		count: counts ? counts[key] : null,
		selected: selected.includes(key),
	})).filter((chip) => chip.selected || chip.count === null || chip.count > 0)
}
