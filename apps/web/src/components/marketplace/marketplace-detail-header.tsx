import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
import { cn } from '@/lib/cn'
import {
	KIND_LABEL_BASE,
	KIND_LABEL_CLASS,
	type MarketplaceKind,
	kindLabel as kindLabelFor,
} from './item-type-label'

interface MarketplaceDetailHeaderProps {
	kind: MarketplaceKind
	name: string
	description: string
	badge?: React.ReactNode
	actions?: React.ReactNode
}

/** Read-only header shared by the marketplace loop and item detail pages —
 * 52px icon tile, colour-coded kind label, name, description and an
 * install-state badge (mockup 2630–2637). The primary Install/Manage cluster
 * lives in the page's own sticky action bar, above the scroll region; `actions`
 * stays available for callers that still want it inline. */
export function MarketplaceDetailHeader({
	kind,
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
						'grid size-[52px] shrink-0 place-items-center rounded-2xl text-lg font-bold',
						getActorAvatarPaletteClass(name),
					)}
					aria-hidden="true"
				>
					{getActorInitials(name)}
				</span>
				<div className="min-w-[200px] flex-1">
					<div className={cn(KIND_LABEL_BASE, 'tracking-[0.09em]', KIND_LABEL_CLASS[kind])}>
						{kindLabelFor(kind)}
					</div>
					<h1 className="mt-1 text-xl font-bold tracking-tight text-foreground">{name}</h1>
				</div>
				{badge}
				{actions}
			</div>
			<p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
		</div>
	)
}
