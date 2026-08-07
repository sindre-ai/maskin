import { ItemCard } from '@/components/marketplace/item-card'
import { MarketplaceLoopCard } from '@/components/marketplace/marketplace-loop-card'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceItemType,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { cn } from '@/lib/cn'

type TypeFilter = 'all' | 'loops' | MarketplaceItemType

const SECTION_ORDER: MarketplaceItemType[] = ['actor', 'trigger', 'skill', 'integration']

const SECTION_TITLE: Record<MarketplaceItemType, string> = {
	actor: 'Agents',
	trigger: 'Triggers',
	skill: 'Skills',
	integration: 'Integrations',
}

export function LoopGrid({
	loops,
	items = [],
	typeFilter,
	workspaceId,
	installLookup,
	installedItemLookup,
	className,
}: {
	loops: MarketplaceLoopSummary[]
	items?: MarketplaceLoopItem[]
	/** Controls which sections are rendered. Defaults to 'all'. */
	typeFilter?: TypeFilter
	workspaceId: string
	/** Receives a loop or item's parent-loop ID and returns its install row. */
	installLookup?: (id: string) => InstalledLoopRow | undefined
	/** Receives a marketplace item ID and returns its individual-install entry. */
	installedItemLookup?: (itemId: string) => MarketplaceItemInstalledEntry | undefined
	className?: string
}) {
	const filter = typeFilter ?? 'all'

	// Multi-type loops (bundles) go in the "Loops" section.
	// Single-type loops go in their matching typed section as loop cards.
	const multiTypeLoops = loops.filter((l) => l.item_types.length > 1)
	const singleTypeLoops = loops.filter((l) => l.item_types.length === 1)

	const itemsByLoop = new Map<string, typeof items>()
	for (const item of items) {
		const list = itemsByLoop.get(item.loop_id) ?? []
		list.push(item)
		itemsByLoop.set(item.loop_id, list)
	}

	const showLoopsSection = filter === 'all' || filter === 'loops'
	const typesToShow: MarketplaceItemType[] =
		filter === 'loops' ? [] : filter === 'all' ? SECTION_ORDER : [filter as MarketplaceItemType]

	const typedSections = typesToShow
		.map((type) => ({
			type,
			loopCards: singleTypeLoops.filter((l) => l.item_types.includes(type)),
			itemCards: items.filter((i) => i.item_type === type),
		}))
		.filter((s) => s.loopCards.length > 0 || s.itemCards.length > 0)

	const hasLoops = showLoopsSection && multiTypeLoops.length > 0
	if (!hasLoops && typedSections.length === 0) return null

	return (
		<div className={cn('space-y-8', className)}>
			{hasLoops && (
				<section className="space-y-3" aria-label="Loops">
					<h2 className="text-sm font-semibold text-foreground">Loops</h2>
					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
						{multiTypeLoops.map((loop) => (
							<MarketplaceLoopCard
								key={loop.id}
								workspaceId={workspaceId}
								loop={loop}
								install={installLookup?.(loop.id)}
								items={itemsByLoop.get(loop.id)}
							/>
						))}
					</div>
				</section>
			)}
			{typedSections.map(({ type, loopCards, itemCards }) => (
				<section key={type} className="space-y-3" aria-label={SECTION_TITLE[type]}>
					<h2 className="text-sm font-semibold text-foreground">{SECTION_TITLE[type]}</h2>
					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
						{loopCards.map((loop) => (
							<MarketplaceLoopCard
								key={loop.id}
								workspaceId={workspaceId}
								loop={loop}
								install={installLookup?.(loop.id)}
								items={itemsByLoop.get(loop.id)}
							/>
						))}
						{itemCards.map((item) => (
							<ItemCard
								key={item.id}
								workspaceId={workspaceId}
								item={item}
								install={installLookup?.(item.loop_id)}
								installedEntity={installedItemLookup?.(item.id)}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	)
}
