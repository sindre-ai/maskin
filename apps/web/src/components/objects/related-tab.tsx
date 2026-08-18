import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useObjectGraph, useObjects } from '@/hooks/use-objects'
import { useCreateRelationship, useDeleteRelationship } from '@/hooks/use-relationships'
import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AddLinkForm } from './linked-objects'
import { RelatedObjectsTable } from './related-objects-table'
import { resolveRelatedRows } from './related-tab-utils'

const DEFAULT_RELATIONSHIP_TYPES = ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates']

/**
 * Related tab for the object detail page (T4). Self-contained — fetches its own
 * graph, renders a name / type / status / when table with a remove action, an
 * empty state with an add-link CTA, and a live count in the header. Mounted by
 * T5 into the tab bar.
 */
export function RelatedTab({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const { data: allObjects } = useObjects(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, object.id)
	const deleteRelationship = useDeleteRelationship(workspaceId, object.id)
	const [showAdd, setShowAdd] = useState(false)

	const settings = workspace.settings as Record<string, unknown>
	const relationshipTypes =
		(settings?.relationship_types as string[] | undefined) ?? DEFAULT_RELATIONSHIP_TYPES

	// Same resolver the tab-trigger count uses, so the header count in this
	// tab and the "(N)" in the assembled tab strip stay in lockstep.
	const resolved = useMemo(
		() => resolveRelatedRows(graph, allObjects, object.id),
		[graph, allObjects, object.id],
	)
	const existingRelationships: RelationshipResponse[] = graph?.relationships ?? []

	const count = resolved.length

	// Grouped by relationship type (mockup 1156–1172) — one labelled bordered
	// list per edge type, in first-occurrence order.
	const groups = useMemo(() => {
		const byType = new Map<string, typeof resolved>()
		for (const row of resolved) {
			const existing = byType.get(row.rel.type)
			if (existing) existing.push(row)
			else byType.set(row.rel.type, [row])
		}
		return [...byType.entries()].map(([type, rows]) => ({ type, rows }))
	}, [resolved])

	return (
		<div className="w-full min-w-0">
			<div className="mb-3 flex items-center justify-between gap-2">
				<h3 className="eyebrow">Related ({count})</h3>
				{count > 0 && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						onClick={() => setShowAdd((v) => !v)}
						aria-label={showAdd ? 'Cancel add link' : 'Add link'}
					>
						<Plus size={14} className="mr-1" />
						Add link
					</Button>
				)}
			</div>

			{showAdd && (
				<AddLinkForm
					objectId={object.id}
					objectType={object.type}
					allObjects={allObjects ?? []}
					relationshipTypes={relationshipTypes}
					existingRelationships={existingRelationships}
					onCreateRelationship={(data) => createRelationship.mutate(data)}
					onClose={() => setShowAdd(false)}
				/>
			)}

			{count === 0 ? (
				<EmptyState
					title="No related objects yet"
					description="Link this object to a related insight, bet, or task to build its graph."
					action={
						<Button variant="secondary" size="sm" onClick={() => setShowAdd(true)}>
							<Plus size={14} className="mr-1" />
							Add link
						</Button>
					}
				/>
			) : (
				<div className="flex flex-col gap-4">
					{groups.map((group) => (
						<div key={group.type}>
							<div className="mb-1.5 flex items-baseline gap-2">
								<span className="eyebrow">{group.type.replace(/_/g, ' ')}</span>
								<span className="text-[10.5px] font-semibold tabular-nums text-muted-foreground/60">
									{group.rows.length}
								</span>
							</div>
							<RelatedObjectsTable
								rows={group.rows}
								workspaceId={workspaceId}
								onDeleteRelationship={(id) => deleteRelationship.mutate(id)}
								showWhen
							/>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
