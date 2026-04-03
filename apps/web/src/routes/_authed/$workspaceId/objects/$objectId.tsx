import { PageHeader } from '@/components/layout/page-header'
import { ObjectCreateForm } from '@/components/objects/object-create-form'
import { ObjectDocument } from '@/components/objects/object-document'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useCreateObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { ApiError } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { getDefaultStatusForType } from '@ai-native/module-sdk'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
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
	const { data: object, isLoading, isError, error } = useObject(objectId, workspaceId)
	const createObject = useCreateObject(workspaceId)
	const updateObject = useUpdateObject(workspaceId)

	// Track whether we've initiated creation for THIS objectId.
	// Comparing against objectId means it auto-invalidates on navigation.
	const [creatingForId, setCreatingForId] = useState<string | null>(null)

	const is404 = isError && error instanceof ApiError && error.status === 404
	const isCreating = creatingForId === objectId

	const handleAutoCreate = async (data: {
		type: string
		title: string
	}) => {
		if (creatingForId === objectId) return
		setCreatingForId(objectId)
		try {
			await createObject.mutateAsync({
				id: objectId,
				type: data.type,
				title: data.title,
				status: getDefaultStatus(data.type),
			})
			toast.success('Object created')
		} catch (err) {
			setCreatingForId(null)
			toast.error(err instanceof Error ? err.message : 'Failed to create object')
		}
	}

	const handleUpdate = useCallback(
		(data: { title?: string; content?: string; status?: string }) => {
			updateObject.mutate({ id: objectId, data })
		},
		[objectId, updateObject],
	)

	// 1. Loading: initial fetch in progress
	if (isLoading && !object && !isCreating) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	// 2. Object exists: show document view
	if (object) {
		return <ObjectDocument object={object} />
	}

	// 3. Non-404 error (and not creating): show error, not create form
	if (isError && !is404 && !isCreating) {
		return (
			<div className="max-w-3xl mx-auto">
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{error?.message || 'Failed to load object'}
				</div>
			</div>
		)
	}

	// 4. 404 or creating: show create form
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
