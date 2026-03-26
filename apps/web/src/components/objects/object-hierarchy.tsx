import type { ObjectResponse, RelationshipResponse, SessionResponse } from '@/lib/api'
import { ObjectRow } from './object-row'

interface ObjectHierarchyProps {
	objects: ObjectResponse[]
	relationships: RelationshipResponse[]
	workspaceId: string
	search: string
	sessionMap?: Map<string, SessionResponse>
}

export function ObjectHierarchy({
	objects,
	relationships,
	workspaceId,
	search,
	sessionMap,
}: ObjectHierarchyProps) {
	const objectById = new Map(objects.map((o) => [o.id, o]))

	// Build a map of bet -> related objects (via informs or breaks_into)
	const betChildren = new Map<string, ObjectResponse[]>()
	for (const rel of relationships) {
		const source = objectById.get(rel.sourceId)
		const target = objectById.get(rel.targetId)
		if (!source || !target) continue

		// insight informs bet: insight is source, bet is target
		if (rel.type === 'informs' && target.type === 'bet') {
			const arr = betChildren.get(target.id) ?? []
			arr.push(source)
			betChildren.set(target.id, arr)
		}
		// bet breaks_into task: bet is source, task is target
		if (rel.type === 'breaks_into' && source.type === 'bet') {
			const arr = betChildren.get(source.id) ?? []
			arr.push(target)
			betChildren.set(source.id, arr)
		}
	}

	// Track which non-bet objects appear under a bet
	const linkedIds = new Set<string>()
	for (const children of betChildren.values()) {
		for (const child of children) {
			linkedIds.add(child.id)
		}
	}

	const bets = objects.filter((o) => o.type === 'bet')
	const orphans = objects.filter((o) => !linkedIds.has(o.id) && o.type !== 'bet')

	const q = search.toLowerCase()
	const matchesSearch = (o: ObjectResponse) =>
		!q || o.title?.toLowerCase().includes(q) || o.content?.toLowerCase().includes(q)

	return (
		<div className="divide-y divide-border">
			{bets.map((bet) => {
				const children = (betChildren.get(bet.id) ?? []).filter(matchesSearch)
				const betMatches = matchesSearch(bet)
				if (!betMatches && children.length === 0) return null
				return (
					<div key={bet.id}>
						<ObjectRow object={bet} workspaceId={workspaceId} sessionMap={sessionMap} />
						{children.map((child) => (
							<ObjectRow
								key={child.id}
								object={child}
								workspaceId={workspaceId}
								indent
								sessionMap={sessionMap}
							/>
						))}
					</div>
				)
			})}
			{orphans.filter(matchesSearch).length > 0 && (
				<div>
					<div className="flex items-center gap-2 py-2 px-3">
						<span className="text-xs font-semibold text-muted-foreground">Unlinked</span>
						<div className="flex-1 h-px bg-border" />
					</div>
					{orphans.filter(matchesSearch).map((o) => (
						<ObjectRow key={o.id} object={o} workspaceId={workspaceId} sessionMap={sessionMap} />
					))}
				</div>
			)}
		</div>
	)
}
