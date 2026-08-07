import { Badge } from '@/components/ui/badge'
import type { InstalledLoopRow, MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { ITEM_TYPE_LABEL } from './item-type-label'
import { LoopInstallControls } from './loop-install-controls'
import { MarketplaceDetailHeader } from './marketplace-detail-header'

interface MarketplaceLoopDetailProps {
	workspaceId: string
	loop: MarketplaceLoopSummary
	items: MarketplaceLoopItem[]
	install?: InstalledLoopRow
}

export function MarketplaceLoopDetail({
	workspaceId,
	loop,
	items,
	install,
}: MarketplaceLoopDetailProps) {
	const locked = install?.isLocked ?? false
	const kindLabel =
		loop.item_types.length === 1 ? ITEM_TYPE_LABEL[loop.item_types[0]] : 'Loop bundle'

	return (
		<div className="space-y-6">
			<MarketplaceDetailHeader
				kindLabel={kindLabel}
				name={loop.name}
				description={loop.description}
				badge={
					install ? (
						locked ? (
							<Badge
								variant="secondary"
								className="shrink-0 whitespace-nowrap text-[11px] font-medium"
							>
								🔒 Managed · v{install.installedVersion}
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="shrink-0 whitespace-nowrap text-[11px] font-medium text-foreground"
							>
								⑂ Forked from v{install.installedVersion}
							</Badge>
						)
					) : undefined
				}
				actions={<LoopInstallControls workspaceId={workspaceId} loop={loop} install={install} />}
			/>

			{items.length > 0 && (
				<div>
					<div className="mb-3 flex items-center gap-2">
						<h2 className="text-sm font-semibold text-foreground">What it brings</h2>
						<span className="text-xs text-muted-foreground">everything installed in one go</span>
					</div>
					<div className="flex flex-col gap-2">
						{items.map((item) => (
							<LoopBringsRow key={item.id} workspaceId={workspaceId} loopId={loop.id} item={item} />
						))}
					</div>
				</div>
			)}
		</div>
	)
}

function LoopBringsRow({
	workspaceId,
	loopId,
	item,
}: {
	workspaceId: string
	loopId: string
	item: MarketplaceLoopItem
}) {
	const snapshot = item.item_snapshot as { name?: unknown; description?: unknown }
	const name =
		typeof snapshot.name === 'string' && snapshot.name.trim() ? snapshot.name : 'Untitled'
	const description = typeof snapshot.description === 'string' ? snapshot.description : null

	return (
		<Link
			to="/$workspaceId/marketplace/$loopId/$itemId"
			params={{ workspaceId, loopId, itemId: item.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 hover:bg-muted/40"
		>
			<span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				{ITEM_TYPE_LABEL[item.item_type]}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium text-foreground">{name}</span>
				{description && (
					<span className="mt-0.5 block truncate text-xs text-muted-foreground">{description}</span>
				)}
			</span>
		</Link>
	)
}
