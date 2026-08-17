import { Badge } from '@/components/ui/badge'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceLoopItem,
} from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { ItemInstallControls } from './item-install-controls'
import { ITEM_TYPE_LABEL } from './item-type-label'

interface ItemCardProps {
	workspaceId: string
	item: MarketplaceLoopItem
	/** Set when the whole parent loop is installed — suppresses individual install/remove. */
	install?: InstalledLoopRow
	/** Set when this specific item was individually installed. */
	installedEntity?: MarketplaceItemInstalledEntry
}

export function ItemCard({ workspaceId, item, install, installedEntity }: ItemCardProps) {
	const snapshot = item.item_snapshot
	const name = (snapshot.name as string) ?? 'Untitled'
	const description = (snapshot.description as string) ?? null
	const locked = install?.isLocked ?? false

	return (
		<article className="relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-border-strong hover:shadow-md">
			<Link
				to="/$workspaceId/marketplace/$loopId/$itemId"
				params={{ workspaceId, loopId: item.loop_id, itemId: item.id }}
				className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={`Open ${name}`}
			/>

			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{name}</h3>
					{description && (
						<p className="mt-1 text-xs text-muted-foreground line-clamp-2">{description}</p>
					)}
				</div>
				{install ? (
					locked ? (
						<Badge
							variant="secondary"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium"
						>
							🔒 Managed
						</Badge>
					) : (
						<Badge
							variant="outline"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium text-foreground"
						>
							⑂ Forked
						</Badge>
					)
				) : null}
			</div>

			<div className="flex flex-wrap gap-1">
				<span className="eyebrow rounded-full bg-muted px-2 py-0.5">
					{ITEM_TYPE_LABEL[item.item_type]}
				</span>
			</div>

			<div className="mt-auto">
				<ItemInstallControls
					workspaceId={workspaceId}
					item={item}
					name={name}
					install={install}
					installedEntity={installedEntity}
				/>
			</div>
		</article>
	)
}
