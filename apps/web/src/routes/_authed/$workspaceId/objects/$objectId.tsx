import { ObjectDocument } from '@/components/objects/object-document'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useObject } from '@/hooks/use-objects'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/objects/$objectId')({
	component: ObjectDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ObjectDetailPage() {
	const { objectId } = Route.useParams()
	const { data: object, isLoading, error } = useObject(objectId)

	if (isLoading) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (error || !object) {
		return (
			<div className="flex items-center justify-center py-16">
				<p className="text-sm text-muted-foreground">{error?.message || 'Object not found'}</p>
			</div>
		)
	}

	return <ObjectDocument object={object} />
}
