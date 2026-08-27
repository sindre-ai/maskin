// PRE-V2 MARKETPLACE ITEM DETAIL — governed by the `new-design` feature flag.
//
// This is the surface exactly as it shipped before the v2 rewrite. The route
// (`routes/_authed/$workspaceId/marketplace/$loopId/$itemId.tsx`) renders it whenever `new-design` is off; the v2 page renders
// when it is on. This whole directory dies with the flag — see
// `.claude/rules/feature-flags.md` ("Retiring a flag").

import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { useInstalledLoops } from '@/hooks/use-installed-loops'
import { useInstalledMarketplaceItems, useMarketplaceLoop } from '@/hooks/use-marketplace-loops'
import { useWorkspace } from '@/lib/workspace-context'
import { MarketplaceItemDetail } from './marketplace-item-detail'

export function LegacyMarketplaceItemDetailPage({
	loopId,
	itemId,
}: { loopId: string; itemId: string }) {
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
			<PageHeader />
			<div className="max-w-3xl mx-auto">
				<MarketplaceItemDetail
					workspaceId={workspaceId}
					item={item}
					parentLoop={data.loop}
					install={install}
					installedEntity={installedEntity}
				/>
			</div>
		</>
	)
}
