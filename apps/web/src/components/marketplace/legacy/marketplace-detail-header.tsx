import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
import { cn } from '@/lib/cn'

interface MarketplaceDetailHeaderProps {
	kindLabel: string
	name: string
	description: string
	badge?: React.ReactNode
	actions?: React.ReactNode
}

/** Read-only header shared by the marketplace loop and item detail pages —
 * icon, kind label, name, description, install-state badge and actions. */
export function MarketplaceDetailHeader({
	kindLabel,
	name,
	description,
	badge,
	actions,
}: MarketplaceDetailHeaderProps) {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-4">
				<span
					className={cn(
						'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-lg font-bold',
						getActorAvatarPaletteClass(name),
					)}
					aria-hidden="true"
				>
					{getActorInitials(name)}
				</span>
				<div className="min-w-[200px] flex-1">
					<div className="font-mono text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
						{kindLabel}
					</div>
					<h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">{name}</h1>
				</div>
				{badge}
			</div>
			<p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
			{actions}
		</div>
	)
}
