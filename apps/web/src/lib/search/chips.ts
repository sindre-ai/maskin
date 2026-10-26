// The chip rows under the search field: which chips to show and what count each
// carries. Counts come from the search endpoint (true totals), never from the rows
// on screen. A chip with no hits is hidden unless it is selected, so a quiet group
// like "Needs you" never looks broken. Before the first answer the counts are null
// and the chips show a dash instead of a misleading 0.

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

export function buildTypeChips(input: {
	/** Every type the workspace can search, in display order. */
	options: TypeOption[]
	/** Per type key; text match only. Null before the first answer. */
	counts: Record<string, number> | null
	selected: string[]
	/** Display name for a type the endpoint returned that the workspace list lacks. */
	fallbackLabel: (key: string) => string
}): TypeChip[] {
	const { options, counts, selected, fallbackLabel } = input
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
			count: counts ? (counts[o.key] ?? 0) : null,
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
