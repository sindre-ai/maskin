import type { ObjectResponse } from '@/lib/api'
import { EmptyState } from '../shared/empty-state'
import { ObjectRow } from './object-row'

export function ObjectList({
	objects,
	workspaceId,
}: {
	objects: ObjectResponse[]
	workspaceId: string
}) {
	if (objects.length === 0) {
		return (
			<EmptyState title="No objects found" description="Create your first object to get started" />
		)
	}

	return (
		<div className="divide-y divide-border">
			{objects.map((object) => (
				<ObjectRow key={object.id} object={object} workspaceId={workspaceId} />
			))}
		</div>
	)
}
