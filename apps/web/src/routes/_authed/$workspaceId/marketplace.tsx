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
type UseCaseFilter = 'all' | string

interface TypeItem {
	value: TypeFilter
	label: string
}

interface UseCaseItem {
	value: UseCaseFilter
	label: string
}

const TYPE_ITEMS: TypeItem[] = [
	{ value: 'all', label: 'All' },
	{ value: 'loops', label: 'Loops' },
	{ value: 'actor', label: 'Agents' },
	{ value: 'trigger', label: 'Triggers' },
	{ value: 'skill', label: 'Skills' },
	{ value: 'integration', label: 'Integrations' },
]

function buildUseCaseItems(counts: MarketplaceLoopCounts | undefined): UseCaseItem[] {
	const base: UseCaseItem[] = [{ value: 'all', label: 'All' }]
	if (!counts) return base
	return [
		...base,
		...Object.keys(counts.by_use_case)
			.sort()
			.map((key) => ({ value: key, label: key })),
	]
}

function MarketplacePage() {
	const { workspaceId } = useWorkspace()
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
	const [useCaseFilter, setUseCaseFilter] = useState<UseCaseFilter>('all')
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

			<nav aria-label="Marketplace filters" className="mb-4 flex flex-col gap-2">
				<div className="flex flex-col gap-2 md:flex-row md:items-center">
					<div className="min-w-0 flex-1 overflow-x-auto" data-testid="marketplace-type-chips">
						<ChipStrip
							items={TYPE_ITEMS}
							active={typeFilter}
							onSelect={(v) => setTypeFilter(v as TypeFilter)}
							counts={counts}
							itemCounts={itemCountsByType}
							kind="type"
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
				</div>
				<ChipStrip
					items={useCaseItems}
					active={useCaseFilter}
					onSelect={(v) => setUseCaseFilter(v as UseCaseFilter)}
					counts={counts}
					itemCounts={itemCountsByType}
					kind="use_case"
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
	kind,
}: {
	items: (TypeItem | UseCaseItem)[]
	active: string
	onSelect: (value: string) => void
	counts: MarketplaceLoopCounts | undefined
	itemCounts: Partial<Record<MarketplaceItemType, number>>
	kind: 'type' | 'use_case'
}) {
	return (
		<div className="flex gap-1.5 overflow-x-auto px-1 pb-1">
			{items.map((item) => {
				const count =
					kind === 'type'
						? countForType(item.value as TypeFilter, counts, itemCounts)
						: countForUseCase(item.value as UseCaseFilter, counts)
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

function countForType(
	value: TypeFilter,
	counts: MarketplaceLoopCounts | undefined,
	itemCounts: Partial<Record<MarketplaceItemType, number>>,
): number | undefined {
	if (!counts) return undefined
	if (value === 'all' || value === 'loops') return counts.total
	// Use item-level count once loaded; fall back to loop-level count.
	return (
		itemCounts[value as MarketplaceItemType] ?? counts.by_type[value as MarketplaceItemType] ?? 0
	)
}

function countForUseCase(
	value: UseCaseFilter,
	counts: MarketplaceLoopCounts | undefined,
): number | undefined {
	if (!counts) return undefined
	if (value === 'all') return counts.total
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
