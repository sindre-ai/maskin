import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { WebAppLink } from '../web-app-link'
import type { ObjectKanbanProps, ObjectResponse } from './types'

/**
 * Kanban view for a heterogeneous object list. Defaults to grouping by
 * status. When a `WorkspaceSchema` is supplied the column order matches the
 * canonical status order from `schema.types[type].statuses`, so e.g.
 * bets always render `signal → proposed → active → completed`.
 *
 * Drag-and-drop is intentionally out of scope for the catalog stub — F7 will
 * layer on `onUpdateStatus` mutations when columns get DnD affordances.
 */
export function ObjectKanban({
	objects,
	schema,
	groupBy = 'status',
	className,
}: ObjectKanbanProps) {
	if (!objects.length) {
		return <EmptyState title="No objects" description="Nothing to group yet." />
	}

	const groups = groupObjects(objects, groupBy, schema)

	return (
		<div className={cn('flex gap-3 overflow-x-auto p-2', className)}>
			{groups.map(([key, items]) => (
				<div key={key} className="min-w-[220px] flex-shrink-0 space-y-2">
					<div className="flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
						<span>{key.replace(/_/g, ' ')}</span>
						<span>{items.length}</span>
					</div>
					<div className="space-y-2">
						{items.map((obj) => (
							<Card key={obj.id} className="p-3 space-y-2">
								<div className="flex items-center justify-between gap-2">
									<TypeBadge type={obj.type} />
									{groupBy !== 'status' && <StatusBadge status={obj.status} />}
								</div>
								<p className="text-sm font-medium text-foreground line-clamp-2">
									{obj.title || 'Untitled'}
								</p>
								<div className="flex justify-end">
									<WebAppLink target={{ kind: 'object', id: obj.id }} label="Open" />
								</div>
							</Card>
						))}
					</div>
				</div>
			))}
		</div>
	)
}

function groupObjects(
	objects: ObjectResponse[],
	groupBy: 'status' | 'type',
	schema: ObjectKanbanProps['schema'],
): Array<[string, ObjectResponse[]]> {
	const buckets = new Map<string, ObjectResponse[]>()
	for (const obj of objects) {
		const key = groupBy === 'status' ? obj.status : obj.type
		const list = buckets.get(key)
		if (list) list.push(obj)
		else buckets.set(key, [obj])
	}

	if (groupBy === 'status' && schema) {
		const ordered = orderedStatusKeys(objects, schema)
		const sorted: Array<[string, ObjectResponse[]]> = []
		for (const k of ordered) {
			const list = buckets.get(k)
			if (list) sorted.push([k, list])
		}
		// Append any keys not covered by the schema-declared order.
		for (const [k, v] of buckets) if (!ordered.includes(k)) sorted.push([k, v])
		return sorted
	}

	return Array.from(buckets.entries())
}

function orderedStatusKeys(
	objects: ObjectResponse[],
	schema: NonNullable<ObjectKanbanProps['schema']>,
): string[] {
	// Use the status order of the dominant type so single-type lists render
	// in canonical order (mixed-type lists fall back to insertion order).
	const counts = new Map<string, number>()
	for (const obj of objects) counts.set(obj.type, (counts.get(obj.type) ?? 0) + 1)
	const dominantType = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
	if (!dominantType) return []
	return schema.types?.[dominantType]?.statuses ?? []
}
