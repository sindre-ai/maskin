import { PageHeader } from '@/components/layout/page-header'
import { ObjectCreateForm } from '@/components/objects/object-create-form'
import { ObjectDocument } from '@/components/objects/object-document'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useCreateObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { getDefaultStatusForType } from '@maskin/module-sdk'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/objects/$objectId')({
	component: ObjectDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ObjectDetailPage() {
	const { objectId } = Route.useParams()
	const { workspaceId, workspace } = useWorkspace()

	// Derive default statuses from workspace settings (first status per type)
	const settings = workspace.settings as Record<string, unknown>
	const statusMap = (settings?.statuses ?? {}) as Record<string, string[]>
	const getDefaultStatus = (type: string) =>
		statusMap[type]?.[0] ?? getDefaultStatusForType(type) ?? 'new'
	const { data: object, isLoading } = useObject(objectId)
	const createObject = useCreateObject(workspaceId)
	const updateObject = useUpdateObject(workspaceId)
	const isCreatedRef = useRef(false)

	// Once the object exists in cache, mark as created
	useEffect(() => {
		if (object) isCreatedRef.current = true
	}, [object])
	const isCreated = isCreatedRef.current || !!object

	const handleAutoCreate = async (data: {
		type: string
		title: string
	}) => {
		if (isCreatedRef.current) return
		isCreatedRef.current = true
		try {
			await createObject.mutateAsync({
				id: objectId,
				type: data.type,
				title: data.title,
				status: getDefaultStatus(data.type),
			})
			toast.success('Object created')
		} catch (err) {
			isCreatedRef.current = false
			toast.error(err instanceof Error ? err.message : 'Failed to create object')
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
				<Skeleton className="h-4 w-full max-w-96" />
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
