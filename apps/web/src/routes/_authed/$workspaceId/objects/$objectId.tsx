import { PageHeader } from '@/components/layout/page-header'
import { ObjectCreateForm } from '@/components/objects/object-create-form'
import { ObjectDetailShell } from '@/components/objects/object-detail-shell'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useCreateObject, useDeleteObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
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
	const deleteObject = useDeleteObject(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
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

	const handleStatusChange = useCallback(
		(status: string) => {
			// `archived` on a bet dispatches to the same archive route as the row
			// ⋯ menu: stamp the current status onto metadata.previous_status.
			if (status === 'archived' && object?.type === 'bet') {
				if (!object || object.status === 'archived') return
				updateObject.mutate({
					id: objectId,
					data: { status: 'archived', metadata: { previous_status: object.status } },
				})
				return
			}
			updateObject.mutate({ id: objectId, data: { status } })
		},
		[objectId, object, updateObject],
	)

	const handleDriverChange = useCallback(
		(driver: string | null) => {
			updateObject.mutate({ id: objectId, data: { driver } })
		},
		[objectId, updateObject],
	)

	const handleDelete = useCallback(() => {
		deleteObject.mutate(objectId)
	}, [objectId, deleteObject])

	if (isLoading && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	// Once fully loaded with object data, render the detail surface
	if (isCreated && object) {
		const statuses = statusMap[object.type] ?? []
		return (
			<ObjectDetailShell
				object={object}
				workspaceId={workspaceId}
				statuses={statuses}
				members={members ?? []}
				onStatusChange={handleStatusChange}
				onDriverChange={handleDriverChange}
				onDelete={handleDelete}
				isDeleting={deleteObject.isPending}
			/>
		)
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
