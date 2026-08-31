import { PageHeader } from '@/components/layout/page-header'
import { LegacyMarketplaceItemDetailPage } from '@/components/marketplace/legacy/marketplace-item-detail-page'
import { MarketplaceItemDetail } from '@/components/marketplace/marketplace-item-detail'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useInstalledLoops } from '@/hooks/use-installed-loops'
import { useInstalledMarketplaceItems, useMarketplaceLoop } from '@/hooks/use-marketplace-loops'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/marketplace/$loopId/$itemId')({
	component: MarketplaceItemDetailRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

// `new-design` boundary for the marketplace item detail page. The pre-v2 branch
// lives under `components/marketplace/legacy/` and dies with the flag.
function MarketplaceItemDetailRoute() {
	const { loopId, itemId } = Route.useParams()
	return useFeatureFlag('new-design') ? (
		<MarketplaceItemDetailPage />
	) : (
		<LegacyMarketplaceItemDetailPage loopId={loopId} itemId={itemId} />
	)
}

function MarketplaceItemDetailPage() {
	const { loopId, itemId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data, isLoading, isError } = useMarketplaceLoop(loopId)
	const { data: installsData } = useInstalledLoops(workspaceId)
	const { data: installedItemsData } = useInstalledMarketplaceItems(workspaceId)

	const item = data?.items.find((i) => i.id === itemId)
	const install = installsData?.installs.find((row) => row.sourceLoopId === loopId)
	const installedEntity = installedItemsData?.items.find((i) => i.marketplace_item_id === itemId)

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
					title="Couldn't load this item"
					description="Something went wrong loading the catalog. Try refreshing."
				/>
			</div>
		)
	}

	if (!data || !item) {
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
			<PageHeader scrollLocked />
			<MarketplaceItemDetail
				workspaceId={workspaceId}
				item={item}
				parentLoop={data.loop}
				install={install}
				installedEntity={installedEntity}
			/>
		</>
	)
}
