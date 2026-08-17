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

	return (
		<div className="w-full min-w-0">
			<div className="mb-3 flex items-center justify-between gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Related ({count})
				</h3>
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
				<RelatedObjectsTable
					rows={resolved}
					workspaceId={workspaceId}
					onDeleteRelationship={(id) => deleteRelationship.mutate(id)}
					showWhen
				/>
			)}
		</div>
	)
}
