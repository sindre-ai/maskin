import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'
import { Button } from '../ui/button'

interface RelationshipsTableProps {
	objectId: string
	relationships: RelationshipResponse[]
	objectsById: Map<string, ObjectResponse>
	workspaceId: string
	onDelete?: (relationshipId: string) => void
}

interface RelationshipRow {
	rel: RelationshipResponse
	linked: ObjectResponse | null
	linkedId: string
	direction: 'outbound' | 'inbound'
}

/**
 * Renders the bet's relationships as a compact table grouped by edge type
 * (informs, breaks_into, blocks…). Used when the Table view is selected on
 * the activity surface — the same edge set as the Timeline projection, just
 * folded into a relational shape (AC-U12).
 */
export function RelationshipsTable({
	objectId,
	relationships,
	objectsById,
	workspaceId,
	onDelete,
}: RelationshipsTableProps) {
	const grouped = useMemo(() => {
		const seen = new Set<string>()
		const byType = new Map<string, RelationshipRow[]>()
		for (const rel of relationships) {
			if (seen.has(rel.id)) continue
			seen.add(rel.id)
			const direction: 'outbound' | 'inbound' = rel.sourceId === objectId ? 'outbound' : 'inbound'
			const linkedId = direction === 'outbound' ? rel.targetId : rel.sourceId
			const linked = objectsById.get(linkedId) ?? null
			const rows = byType.get(rel.type) ?? []
			rows.push({ rel, linked, linkedId, direction })
			byType.set(rel.type, rows)
		}
		// Stable display order: known types first, then the rest alphabetically.
		const knownOrder = ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates', 'attached']
		const known = knownOrder.filter((t) => byType.has(t))
		const others = [...byType.keys()].filter((t) => !knownOrder.includes(t)).sort()
		return [...known, ...others].map((type) => ({ type, rows: byType.get(type) ?? [] }))
	}, [relationships, objectId, objectsById])

	if (grouped.length === 0) {
		return <p className="text-sm text-muted-foreground py-4 text-center">No related objects yet</p>
	}

	return (
		<div className="space-y-4">
			{grouped.map(({ type, rows }) => (
				<section key={type}>
					<h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
						{type.replace(/_/g, ' ')}
						<span className="ml-1 text-muted-foreground/70 normal-case">({rows.length})</span>
					</h4>
					<div className="rounded border border-border divide-y divide-border">
						{rows.map(({ rel, linked, linkedId, direction }) => (
							<div key={rel.id} className="group flex items-center gap-2 px-2 py-1.5 text-sm">
								<span className="text-[10px] uppercase tracking-wider text-muted-foreground w-12 shrink-0">
									{direction === 'outbound' ? '→' : '←'}
								</span>
								{linked ? (
									<Link
										to="/$workspaceId/objects/$objectId"
										params={{ workspaceId, objectId: linked.id }}
										className="text-foreground hover:underline truncate min-w-0 flex-1"
									>
										{linked.title || 'Untitled'}
									</Link>
								) : (
									<span className="text-muted-foreground line-through truncate flex-1 min-w-0">
										{(direction === 'outbound' ? rel.targetTitle : rel.sourceTitle) ??
											`Unknown (${linkedId.slice(0, 8)})`}
									</span>
								)}
								{linked && <TypeBadge type={linked.type} />}
								{linked && <StatusBadge status={linked.status} />}
								{onDelete && (
									<Button
										variant="ghost"
										size="icon"
										className="h-6 w-6 opacity-0 group-hover:opacity-100"
										aria-label="Remove link"
										title="Remove link"
										onClick={() => onDelete(rel.id)}
									>
										<Trash2 size={12} />
									</Button>
								)}
							</div>
						))}
					</div>
				</section>
			))}
		</div>
	)
}
