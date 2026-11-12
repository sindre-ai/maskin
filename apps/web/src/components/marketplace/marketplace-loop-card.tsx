import { getActorInitials, getActorPlateStyle } from '@/components/shared/actor-avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type {
	InstalledLoopRow,
	MarketplaceItemType,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ITEM_TYPE_LABEL } from './item-type-label'
import { LoopInstallControls } from './loop-install-controls'
import { MarketplaceRow } from './marketplace-row'

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
	const isBundle = loop.item_types.length >= 2

	return (
		<MarketplaceRow
			name={loop.name}
			description={loop.description}
			overlay={
				<Link
					to="/$workspaceId/marketplace/$loopId"
					params={{ workspaceId, loopId: loop.id }}
					className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={`Open ${loop.name}`}
				/>
			}
			// The chip buttons (given `relative`) paint above the overlay link to
			// catch their own clicks (buttons can't nest in an anchor). Single-type
			// rows carry the same chip row, naming what they install by kind.
			extra={
				isBundle && items && items.length > 0 ? (
					<CompositionChipRow items={items} />
				) : (
					<KindChipRow itemTypes={loop.item_types} />
				)
			}
			action={<LoopInstallControls row workspaceId={workspaceId} loop={loop} install={install} />}
		/>
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
									className="relative inline-flex max-w-full cursor-help items-center gap-1 rounded-full border border-border bg-muted py-0.5 pr-2 pl-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

function KindChipRow({ itemTypes }: { itemTypes: MarketplaceItemType[] }) {
	if (itemTypes.length === 0) return null

	return (
		<div className="flex flex-wrap gap-1" aria-label="Card composition" data-testid="kind-chip-row">
			{itemTypes.map((type) => (
				<span
					key={type}
					className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted py-0.5 pr-2 pl-0.5 text-[11px] font-medium text-muted-foreground"
				>
					<span
						aria-hidden="true"
						className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[9px] font-semibold leading-none"
					>
						◆
					</span>
					<span className="truncate">{ITEM_TYPE_LABEL[type]}</span>
				</span>
			))}
		</div>
	)
}

function CompositionGlyph({ chip }: { chip: CompositionChip }) {
	const base =
		'inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none shrink-0'
	if (chip.kind === 'actor') {
		return (
			<span className={base} style={getActorPlateStyle(chip.name)} aria-hidden="true">
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
