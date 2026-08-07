import { PageHeader } from '@/components/layout/page-header'
import { MarketplaceLoopDetail } from '@/components/marketplace/marketplace-loop-detail'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useInstalledLoops } from '@/hooks/use-installed-loops'
import { useMarketplaceLoop } from '@/hooks/use-marketplace-loops'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/marketplace/$loopId/')({
	component: MarketplaceLoopDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function MarketplaceLoopDetailPage() {
	const { loopId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data, isLoading, isError } = useMarketplaceLoop(loopId)
	const { data: installsData } = useInstalledLoops(workspaceId)
	const install = installsData?.installs.find((row) => row.sourceLoopId === loopId)

	if (isLoading && !data) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (isError) {
		return (
			<div className="max-w-3xl mx-auto">
				<EmptyState
					title="Couldn't load this loop"
					description="Something went wrong loading the catalog. Try refreshing."
				/>
			</div>
		)
	}

	if (!data) {
		return (
			<div className="max-w-3xl mx-auto">
				<EmptyState
					title="Not found"
					description="This marketplace item may have been removed from the catalog."
				/>
			</div>
		)
	}

	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto">
				<MarketplaceLoopDetail
					workspaceId={workspaceId}
					loop={data.loop}
					items={data.items}
					install={install}
				/>
			</div>
		</>
	)
}
