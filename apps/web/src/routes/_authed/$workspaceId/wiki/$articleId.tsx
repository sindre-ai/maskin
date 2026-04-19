import { PageHeader } from '@/components/layout/page-header'
import { ObjectDocument } from '@/components/objects/object-document'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { WikiLayout } from '@/components/wiki/wiki-layout'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useObject, useObjects } from '@/hooks/use-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/wiki/$articleId')({
	component: WikiArticlePage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WikiArticlePage() {
	const { articleId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const enabled = useEnabledModules()

	if (!enabled.includes('knowledge')) {
		return (
			<>
				<PageHeader />
				<EmptyState
					title="Knowledge extension is not enabled"
					description="Enable the Knowledge module on this workspace to read the wiki."
				/>
			</>
		)
	}

	return <WikiArticle workspaceId={workspaceId} articleId={articleId} />
}

function WikiArticle({ workspaceId, articleId }: { workspaceId: string; articleId: string }) {
	const { data: articles } = useObjects(workspaceId, { type: 'knowledge' })
	const { data: object, isLoading } = useObject(articleId)

	if (isLoading && !object) {
		return (
			<WikiLayout workspaceId={workspaceId} articles={articles ?? []}>
				<div className="max-w-3xl mx-auto pt-8 space-y-3">
					<Skeleton className="h-7 w-2/3" />
					<Skeleton className="h-4 w-1/3" />
					<Skeleton className="h-40 w-full" />
				</div>
			</WikiLayout>
		)
	}

	if (!object || object.type !== 'knowledge') {
		return (
			<WikiLayout workspaceId={workspaceId} articles={articles ?? []}>
				<EmptyState
					title="Article not found"
					description="The article may have been deleted, or this id does not belong to a knowledge article."
				/>
			</WikiLayout>
		)
	}

	return (
		<WikiLayout workspaceId={workspaceId} articles={articles ?? []}>
			<div className="px-6 py-6">
				<ObjectDocument object={object} />
			</div>
		</WikiLayout>
	)
}
