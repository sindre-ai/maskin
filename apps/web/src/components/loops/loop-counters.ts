/**
 * The Proposed / In progress / Done counters of a flow's Overview, derived
 * from the statuses the flow's own items carry. Statuses are workspace
 * configurable, so a status is mapped to a counter by name; a counter with no
 * matching status anywhere (neither in the workspace's status chains nor on an
 * item) is hidden rather than drawn as a made-up zero.
 */
const GROUPS = [
	{
		key: 'proposed',
		label: 'Proposed',
		statuses: ['proposed', 'new', 'backlog', 'todo', 'opportunity', 'pending', 'queued'],
	},
	{
		key: 'in_progress',
		label: 'In progress',
		statuses: ['in_progress', 'active', 'processing', 'in_review', 'running', 'blocked'],
	},
	{
		key: 'done',
		label: 'Done',
		statuses: ['done', 'completed', 'succeeded', 'validated', 'live'],
	},
] as const

export interface LoopCounter {
	key: (typeof GROUPS)[number]['key']
	label: string
	count: number
}

export function loopCounters(
	items: { status: string }[],
	/** The workspace's status chains by object type (`settings.statuses`). */
	statusChains?: Record<string, string[]>,
): LoopCounter[] {
	const known = new Set<string>(items.map((i) => i.status))
	for (const chain of Object.values(statusChains ?? {})) for (const s of chain) known.add(s)
	const counters: LoopCounter[] = []
	for (const group of GROUPS) {
		const names = new Set<string>(group.statuses)
		if (![...known].some((s) => names.has(s))) continue
		counters.push({
			key: group.key,
			label: group.label,
			count: items.filter((i) => names.has(i.status)).length,
		})
	}
	return counters
}

/**
 * The flow's items that wait on the viewer: those with a pending needs_input
 * notification addressed to them, in the order the notifications arrived.
 */
export function itemsNeedingYou<
	T extends { id: string; title: string | null },
	N extends {
		objectId: string | null
		status: string
		targetActorId: string | null
		title: string
	},
>(items: T[], notifications: N[], actorId: string | undefined): { item: T; ask: N }[] {
	const byId = new Map(items.map((i) => [i.id, i]))
	const seen = new Set<string>()
	const rows: { item: T; ask: N }[] = []
	for (const n of notifications) {
		if (n.status !== 'pending' || !n.objectId || n.targetActorId !== actorId) continue
		const item = byId.get(n.objectId)
		if (!item || seen.has(item.id)) continue
		seen.add(item.id)
		rows.push({ item, ask: n })
	}
	return rows
}
