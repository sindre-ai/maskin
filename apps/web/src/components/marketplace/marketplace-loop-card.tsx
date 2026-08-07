import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type {
	InstalledLoopRow,
	MarketplaceItemType,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { LoopInstallControls } from './loop-install-controls'
import { UpdateAvailableBanner } from './update-available-banner'

interface MarketplaceLoopCardProps {
	workspaceId: string
	loop: MarketplaceLoopSummary
	install?: InstalledLoopRow
	/**
	 * Items belonging to this loop. Used to render the composition chip row
	 * on bundle cards (loops with ≥2 component types). When omitted or empty
	 * on a bundle card, the row silently hides.
	 */
	items?: MarketplaceLoopItem[]
}

export function MarketplaceLoopCard({
	workspaceId,
	loop,
	install,
	items,
}: MarketplaceLoopCardProps) {
	const locked = install?.isLocked ?? false
	const showUpdateBanner = locked && install?.hasUpdate === true
	const isBundle = loop.item_types.length >= 2

	return (
		<article className="relative flex flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-sm transition-colors hover:bg-muted/40">
			<Link
				to="/$workspaceId/marketplace/$loopId"
				params={{ workspaceId, loopId: loop.id }}
				className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={`Open ${loop.name}`}
			/>

			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{loop.name}</h3>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2">{loop.description}</p>
				</div>
				{install ? (
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
				) : null}
			</div>

			{/* This row is never itself positioned, so it paints below the overlay
			    link and any empty space still opens the card. Only the chip buttons
			    (given `relative`) paint above the link to catch their own clicks
			    (buttons can't nest in an anchor). */}
			{isBundle && items && items.length > 0 ? (
				<CompositionChipRow items={items} />
			) : (
				<div className="flex flex-wrap gap-1">
					{loop.item_types.map((type) => (
						<span
							key={type}
							className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
						>
							{type}
						</span>
					))}
				</div>
			)}

			{showUpdateBanner ? <UpdateAvailableBanner newVersion={install.availableVersion} /> : null}

			<div className="mt-auto">
				<LoopInstallControls workspaceId={workspaceId} loop={loop} install={install} />
			</div>
		</article>
	)
}

// Shape the raw marketplace items into the chip descriptors the row renders:
// a single chip per integration, plus a count chip for agents and triggers
// whenever there's more than one — a lone agent still gets its own named chip.
type CompositionChip =
	| { key: string; kind: 'actor'; name: string; label: string; initial: string }
	| { key: string; kind: 'count'; itemKind: 'agent' | 'trigger'; count: number; names: string[] }
	| { key: string; kind: 'integration'; name: string; label: string; initial: string }

function itemName(item: MarketplaceLoopItem): string {
	const raw = (item.item_snapshot as { name?: unknown } | null)?.name
	return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'Untitled'
}

function buildChips(items: MarketplaceLoopItem[]): CompositionChip[] {
	const chips: CompositionChip[] = []
	const actorNames: string[] = []
	const triggerNames: string[] = []

	for (const item of items) {
		const type = item.item_type as MarketplaceItemType
		if (type === 'actor') {
			actorNames.push(itemName(item))
		} else if (type === 'integration') {
			const name = itemName(item)
			chips.push({
				key: `integration-${item.id}`,
				kind: 'integration',
				name,
				label: name,
				initial: (name[0] ?? '?').toUpperCase(),
			})
		} else if (type === 'trigger') {
			triggerNames.push(itemName(item))
		}
	}

	if (actorNames.length === 1) {
		const name = actorNames[0]
		chips.unshift({
			key: 'actor-single',
			kind: 'actor',
			name,
			label: name,
			initial: (getActorInitials(name)[0] ?? '?').toUpperCase(),
		})
	} else if (actorNames.length > 1) {
		chips.unshift({
			key: 'agents-count',
			kind: 'count',
			itemKind: 'agent',
			count: actorNames.length,
			names: actorNames,
		})
	}

	if (triggerNames.length > 0) {
		chips.push({
			key: 'triggers-count',
			kind: 'count',
			itemKind: 'trigger',
			count: triggerNames.length,
			names: triggerNames,
		})
	}

	return chips
}

function CompositionChipRow({ items }: { items: MarketplaceLoopItem[] }) {
	const chips = buildChips(items)
	if (chips.length === 0) return null

	return (
		<TooltipProvider delayDuration={150}>
			<div
				className="flex flex-wrap gap-1"
				aria-label="Bundle composition"
				data-testid="composition-chip-row"
			>
				{chips.map((chip) => {
					const tip =
						chip.kind === 'actor'
							? `Agent · ${chip.name}`
							: chip.kind === 'integration'
								? `Integration · ${chip.name}`
								: chip.names.join(' · ')
					const label =
						chip.kind === 'count'
							? `${chip.count} ${chip.itemKind}${chip.count === 1 ? '' : 's'}`
							: chip.label
					return (
						<Tooltip key={chip.key}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={tip}
									className="relative inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-2 pl-0.5 text-[11px] font-medium text-muted-foreground cursor-help hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<CompositionGlyph chip={chip} />
									<span className="truncate">{label}</span>
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">{tip}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</TooltipProvider>
	)
}

function CompositionGlyph({ chip }: { chip: CompositionChip }) {
	const base =
		'inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none shrink-0'
	if (chip.kind === 'actor') {
		return (
			<span className={cn(base, getActorAvatarPaletteClass(chip.name))} aria-hidden="true">
				{chip.initial}
			</span>
		)
	}
	if (chip.kind === 'integration') {
		return (
			<span
				className={cn(base, 'border border-border bg-muted text-muted-foreground')}
				aria-hidden="true"
			>
				{chip.initial}
			</span>
		)
	}
	return (
		<span
			className={cn(base, 'border border-border bg-muted text-muted-foreground')}
			aria-hidden="true"
		>
			{chip.itemKind === 'agent' ? 'A' : '↯'}
		</span>
	)
}
