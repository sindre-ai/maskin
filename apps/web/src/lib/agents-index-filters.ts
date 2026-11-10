/** The catch-all team for an agent with no tags. */
export const NO_TEAM = 'No team'

export interface TeamChip {
	team: string
	count: number
}

/**
 * One chip per team that has agents, A to Z with the catch-all last. A team is
 * the first tag an agent carries, so a tag whose agents all sit under an
 * earlier tag has no chip: a chip with a zero beside it filters to nothing.
 */
export function buildTeamChips(teams: string[]): TeamChip[] {
	const counts = new Map<string, number>()
	for (const team of teams) counts.set(team, (counts.get(team) ?? 0) + 1)
	return [...counts.entries()]
		.sort(([a], [b]) => {
			if (a === NO_TEAM) return b === NO_TEAM ? 0 : 1
			if (b === NO_TEAM) return -1
			return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
		})
		.map(([team, count]) => ({ team, count }))
}

export interface AgentFilterPill {
	/** `status` or `team`. */
	id: 'status' | 'team'
	label: string
	value: string
}

/**
 * The removable pills for the active filters, in a fixed order. `statusLabels`
 * maps a status bucket to its display name; an unknown bucket keeps its key.
 */
export function buildAgentFilterPills({
	statuses,
	team,
	statusLabel,
}: {
	statuses: string[]
	team: string | undefined
	statusLabel: (bucket: string) => string
}): AgentFilterPill[] {
	const pills: AgentFilterPill[] = []
	if (statuses.length > 0) {
		pills.push({ id: 'status', label: 'Status', value: statuses.map(statusLabel).join(', ') })
	}
	if (team) pills.push({ id: 'team', label: 'Team', value: team })
	return pills
}
