import { groupLoopsByUseCase } from '@/components/marketplace/group-loops'
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

	// Multi-type loops (bundles) go in the "Flows" section.
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

	const flowGroups = groupLoopsByUseCase(multiTypeLoops)
	const hasLoops = showLoopsSection && multiTypeLoops.length > 0
	if (!hasLoops && typedSections.length === 0) return null

	return (
		<div className={cn('space-y-1', className)}>
			{hasLoops && (
				<section aria-label="Flows">
					<SectionHeader title="Flows" count={multiTypeLoops.length} />
					<div>
						{flowGroups.map((group) => (
							<div key={group.name} data-testid="flow-group">
								{flowGroups.length > 1 ? (
									<SectionHeader title={group.name} count={group.loops.length} as="span" />
								) : null}
								{group.loops.map((loop) => (
									<MarketplaceLoopCard
										key={loop.id}
										workspaceId={workspaceId}
										loop={loop}
										install={installLookup?.(loop.id)}
										items={itemsByLoop.get(loop.id)}
									/>
								))}
							</div>
						))}
					</div>
				</section>
			)}
			{typedSections.map(({ type, loopCards, itemCards }) => (
				<section key={type} aria-label={SECTION_TITLE[type]}>
					<SectionHeader title={SECTION_TITLE[type]} count={loopCards.length + itemCards.length} />
					<div>
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

// v16 group header: name in bold with the count beside it and a rule above;
// the first row's own rule closes it. The count sits outside the <h2> so the
// heading's accessible name stays the bare section name.
function SectionHeader({
	title,
	count,
	as: Title = 'h2',
}: {
	title: string
	count: number
	/** Flow sub-groups use a span so only the type section is a heading. */
	as?: 'h2' | 'span'
}) {
	return (
		<div className="flex items-baseline gap-2 border-t border-border px-2 pt-4 pb-1.5">
			<Title className="text-sm font-bold text-foreground">{title}</Title>
			<span className="text-[12.5px] text-muted-foreground tabular-nums">{count}</span>
		</div>
	)
}
