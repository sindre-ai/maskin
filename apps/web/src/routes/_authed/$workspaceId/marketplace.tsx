import { PageHeader } from '@/components/layout/page-header'
import { LoopGrid } from '@/components/marketplace/loop-grid'
import { MarketplaceHeaderIdentity } from '@/components/marketplace/marketplace-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { Input } from '@/components/ui/input'
import { useInstalledLoops } from '@/hooks/use-installed-loops'
import { useInstalledMarketplaceItems, useMarketplaceLoops } from '@/hooks/use-marketplace-loops'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceItemType,
	MarketplaceLoopCounts,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueries } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/marketplace')({
	component: MarketplacePage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

type TypeFilter = 'all' | 'loops' | MarketplaceItemType
type FilterValue = TypeFilter | string

interface FilterItem {
	value: FilterValue
	label: string
}

const TYPE_VALUES = new Set<FilterValue>(['loops', 'actor', 'trigger', 'skill', 'integration'])

const TYPE_ITEMS: FilterItem[] = [
	{ value: 'loops', label: 'Loops' },
	{ value: 'actor', label: 'Agents' },
	{ value: 'trigger', label: 'Triggers' },
	{ value: 'skill', label: 'Skills' },
	{ value: 'integration', label: 'Integrations' },
]

function buildUseCaseItems(counts: MarketplaceLoopCounts | undefined): FilterItem[] {
	if (!counts) return []
	return Object.keys(counts.by_use_case)
		.sort()
		.map((key) => ({ value: key, label: key }))
}

function MarketplacePage() {
	const { workspaceId } = useWorkspace()
	const [activeFilter, setActiveFilter] = useState<FilterValue>('all')
	const [query, setQuery] = useState('')
	const trimmedQuery = query.trim()

	const { data, isLoading, isError } = useMarketplaceLoops()
	const counts = data?.counts
	const loops = data?.loops ?? []
	const useCaseItems = useMemo(() => buildUseCaseItems(counts), [counts])

	// Fetch individual items for multi-type loops (bundles) so they can be
	// shown independently in the Agents / Triggers / etc. sections.
	const multiTypeLoopIds = useMemo(
		() => loops.filter((l) => l.item_types.length > 1).map((l) => l.id),
		[loops],
	)
	const detailQueries = useQueries({
		queries: multiTypeLoopIds.map((id) => ({
			queryKey: queryKeys.marketplaceLoops.detail(id),
			queryFn: () => api.marketplaceLoops.get(id),
		})),
	})
	const allItems = useMemo(() => detailQueries.flatMap((q) => q.data?.items ?? []), [detailQueries])

	// Item-level type counts for the sidebar (prefer item granularity once loaded).
	const itemCountsByType = useMemo(() => {
		const c: Partial<Record<MarketplaceItemType, number>> = {}
		for (const item of allItems) {
			const t = item.item_type as MarketplaceItemType
			c[t] = (c[t] ?? 0) + 1
		}
		return c
	}, [allItems])

	// Hide chips with a known zero count — "All" always stays since it's the reset action.
	const filterItems = useMemo(() => {
		const dynamicItems = [...TYPE_ITEMS, ...useCaseItems].filter((item) => {
			const count = countForFilter(item.value, counts, itemCountsByType)
			return count === undefined || count > 0
		})
		return [{ value: 'all', label: 'All' }, ...dynamicItems]
	}, [useCaseItems, counts, itemCountsByType])

	// A selected filter is either a type ('loops' / 'actor' / ...) or a use-case
	// label — only one can be active at a time, so derive both from the same value.
	const typeFilter: TypeFilter = TYPE_VALUES.has(activeFilter)
		? (activeFilter as TypeFilter)
		: 'all'
	const useCaseFilter =
		TYPE_VALUES.has(activeFilter) || activeFilter === 'all' ? 'all' : activeFilter

	// Loop lookup for use-case filtering of items.
	const loopById = useMemo(() => {
		const m = new Map<string, MarketplaceLoopSummary>()
		for (const loop of loops) m.set(loop.id, loop)
		return m
	}, [loops])

	const filteredLoops = useMemo(
		() =>
			loops
				.filter((loop) => useCaseFilter === 'all' || loop.use_case === useCaseFilter)
				.filter((loop) => matchesLoopQuery(loop, trimmedQuery)),
		[loops, useCaseFilter, trimmedQuery],
	)

	const filteredItems = useMemo(
		() =>
			allItems
				.filter(
					(item) =>
						useCaseFilter === 'all' || loopById.get(item.loop_id)?.use_case === useCaseFilter,
				)
				.filter((item) => matchesItemQuery(item, trimmedQuery)),
		[allItems, useCaseFilter, loopById, trimmedQuery],
	)

	const { data: installsData } = useInstalledLoops(workspaceId)
	const installsByLoop = useMemo(() => {
		const map = new Map<string, InstalledLoopRow>()
		for (const row of installsData?.installs ?? []) {
			map.set(row.sourceLoopId, row)
		}
		return map
	}, [installsData])

	const { data: installedItemsData } = useInstalledMarketplaceItems(workspaceId)
	const installedItemsById = useMemo(() => {
		const map = new Map<string, MarketplaceItemInstalledEntry>()
		for (const entry of installedItemsData?.items ?? []) {
			map.set(entry.marketplace_item_id, entry)
		}
		return map
	}, [installedItemsData])

	const isMarketplaceEmpty = !isLoading && !isError && loops.length === 0
	const hasResults = filteredLoops.length > 0 || filteredItems.length > 0
	const isFilterEmpty = !isLoading && !isError && !isMarketplaceEmpty && !hasResults

	return (
		<div className="flex flex-col h-full min-h-0">
			<PageHeader
				stickyIdentity={
					<MarketplaceHeaderIdentity count={data && loops.length > 0 ? loops.length : undefined} />
				}
			/>

			<nav
				aria-label="Marketplace filters"
				className="mb-4 flex flex-col gap-2 md:flex-row md:items-center"
			>
				<div className="min-w-0 flex-1" data-testid="marketplace-filter-chips">
					<ChipStrip
						items={filterItems}
						active={activeFilter}
						onSelect={setActiveFilter}
						counts={counts}
						itemCounts={itemCountsByType}
					/>
				</div>
				<Input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search the marketplace…"
					aria-label="Filter marketplace"
					className="w-full shrink-0 md:w-80"
				/>
			</nav>

			<div className="flex-1 min-w-0">
				{isError ? (
					<p className="text-sm text-muted-foreground">
						Couldn't load the marketplace right now. Try refreshing.
					</p>
				) : isLoading ? (
					<p className="text-sm text-muted-foreground">Loading marketplace…</p>
				) : isMarketplaceEmpty ? (
					<p className="text-sm text-muted-foreground">
						No loops yet — check back once Maskin publishes the first one.
					</p>
				) : isFilterEmpty ? (
					<EmptyState
						title="No matches"
						description="Try a different search term or clear the filters."
					/>
				) : (
					<LoopGrid
						loops={filteredLoops}
						items={filteredItems}
						typeFilter={typeFilter}
						workspaceId={workspaceId}
						installLookup={(id) => installsByLoop.get(id)}
						installedItemLookup={(id) => installedItemsById.get(id)}
					/>
				)}
			</div>
		</div>
	)
}

function ChipStrip({
	items,
	active,
	onSelect,
	counts,
	itemCounts,
}: {
	items: FilterItem[]
	active: string
	onSelect: (value: string) => void
	counts: MarketplaceLoopCounts | undefined
	itemCounts: Partial<Record<MarketplaceItemType, number>>
}) {
	return (
		<div className="flex gap-1.5 overflow-x-auto px-1 pb-1">
			{items.map((item) => {
				const count = countForFilter(item.value, counts, itemCounts)
				const isActive = active === item.value
				return (
					<button
						key={item.value}
						type="button"
						onClick={() => onSelect(item.value)}
						className={cn(
							'shrink-0 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors',
							isActive
								? 'border-foreground bg-foreground text-background'
								: 'border-border bg-background text-muted-foreground hover:text-foreground',
						)}
					>
						{item.label}
						{typeof count === 'number' ? (
							<>
								{' '}
								<span className={cn('ml-1.5 tabular-nums', isActive ? 'opacity-80' : 'opacity-60')}>
									{count}
								</span>
							</>
						) : null}
					</button>
				)
			})}
		</div>
	)
}

const ATOM_TYPES: MarketplaceItemType[] = ['actor', 'trigger', 'skill', 'integration']

function countForType(
	type: MarketplaceItemType,
	counts: MarketplaceLoopCounts,
	itemCounts: Partial<Record<MarketplaceItemType, number>>,
): number {
	// Use item-level count once loaded; fall back to loop-level count.
	return itemCounts[type] ?? counts.by_type[type] ?? 0
}

function countForFilter(
	value: FilterValue,
	counts: MarketplaceLoopCounts | undefined,
	itemCounts: Partial<Record<MarketplaceItemType, number>>,
): number | undefined {
	if (!counts) return undefined
	if (value === 'loops') return counts.total
	if (value === 'all') {
		// Total catalog size across every installable type — not the loop count.
		return ATOM_TYPES.reduce((sum, type) => sum + countForType(type, counts, itemCounts), 0)
	}
	if (TYPE_VALUES.has(value)) {
		return countForType(value as MarketplaceItemType, counts, itemCounts)
	}
	return counts.by_use_case[value] ?? 0
}

function matchesLoopQuery(loop: MarketplaceLoopSummary, query: string): boolean {
	if (!query) return true
	const needle = query.toLowerCase()
	return (
		loop.name.toLowerCase().includes(needle) ||
		loop.description.toLowerCase().includes(needle) ||
		(loop.use_case?.toLowerCase().includes(needle) ?? false)
	)
}

function matchesItemQuery(item: MarketplaceLoopItem, query: string): boolean {
	if (!query) return true
	const needle = query.toLowerCase()
	const snapshot = item.item_snapshot as { name?: unknown; description?: unknown } | null
	const name = typeof snapshot?.name === 'string' ? snapshot.name : ''
	const description = typeof snapshot?.description === 'string' ? snapshot.description : ''
	return name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)
}
