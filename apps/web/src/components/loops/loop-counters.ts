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
