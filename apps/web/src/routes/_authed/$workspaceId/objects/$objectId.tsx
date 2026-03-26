import { PageHeader } from '@/components/layout/page-header'
import { ObjectCreateForm } from '@/components/objects/object-create-form'
import { ObjectDocument } from '@/components/objects/object-document'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useCreateObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/objects/$objectId')({
	component: ObjectDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const defaultStatuses: Record<string, string> = {
	insight: 'new',
	bet: 'signal',
	task: 'todo',
}

function ObjectDetailPage() {
	const { objectId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: object, isLoading } = useObject(objectId, workspaceId)
	const createObject = useCreateObject(workspaceId)
	const updateObject = useUpdateObject(workspaceId)
	const isCreatedRef = useRef(false)

	// Once the object exists in cache, mark as created
	useEffect(() => {
		if (object) isCreatedRef.current = true
	}, [object])
	const isCreated = isCreatedRef.current || !!object

	const handleAutoCreate = async (data: {
		type: 'insight' | 'bet' | 'task'
		title: string
	}) => {
		if (isCreatedRef.current) return
		isCreatedRef.current = true
		try {
			await createObject.mutateAsync({
				id: objectId,
				type: data.type,
				title: data.title,
				status: defaultStatuses[data.type],
			})
			toast.success('Object created')
		} catch {
			isCreatedRef.current = false
		}
	}

	const handleUpdate = useCallback(
		(data: { title?: string; content?: string; status?: string }) => {
			updateObject.mutate({ id: objectId, data })
		},
		[objectId, updateObject],
	)

	if (isLoading && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	// Once fully loaded with object data, render the full document editor
	if (isCreated && object) {
		return <ObjectDocument object={object} />
	}

	// Create mode — show form with document-like sections
	return (
		<>
			<PageHeader />
			<ObjectCreateForm
				objectId={objectId}
				object={object}
				onAutoCreate={handleAutoCreate}
				onUpdate={handleUpdate}
				isPending={createObject.isPending}
				error={createObject.error}
			/>
		</>
	)
}
