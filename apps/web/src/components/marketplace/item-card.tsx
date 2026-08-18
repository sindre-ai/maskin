import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
import { Badge } from '@/components/ui/badge'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceLoopItem,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ItemInstallControls } from './item-install-controls'
import { ITEM_TYPE_LABEL, KIND_LABEL_BASE, KIND_LABEL_CLASS } from './item-type-label'

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

			<div className="flex items-start gap-3">
				{/* 38px identity tile (mockup 2588) — same treatment as the loop card
				    and the detail header. */}
				<span
					aria-hidden="true"
					className={cn(
						'grid size-[38px] shrink-0 place-items-center rounded-xl text-sm font-bold',
						getActorAvatarPaletteClass(name),
					)}
				>
					{getActorInitials(name)}
				</span>
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-[13.5px] font-bold text-foreground">{name}</h3>
					<div
						className={cn(KIND_LABEL_BASE, 'mt-0.5', KIND_LABEL_CLASS[item.item_type])}
						data-testid="item-card-kind"
					>
						{ITEM_TYPE_LABEL[item.item_type]}
					</div>
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

			{description && (
				<p className="text-xs leading-relaxed text-muted-foreground line-clamp-3">{description}</p>
			)}

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
