import { PackageGrid } from '@/components/catalog/package-grid'
import { RouteError } from '@/components/shared/route-error'
import { useCatalogPackages, useInstalledCatalogItems } from '@/hooks/use-catalog-packages'
import { useInstalledPackages } from '@/hooks/use-installed-packages'
import type {
	CatalogItemInstalledEntry,
	CatalogItemType,
	CatalogPackageCounts,
	CatalogPackageItem,
	CatalogPackageSummary,
	InstalledPackageRow,
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

type TypeFilter = 'all' | 'packages' | CatalogItemType
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
	{ value: 'packages', label: 'Packages' },
	{ value: 'actor', label: 'Agents' },
	{ value: 'trigger', label: 'Triggers' },
	{ value: 'skill', label: 'Skills' },
	{ value: 'integration', label: 'Integrations' },
]

function buildUseCaseItems(counts: CatalogPackageCounts | undefined): UseCaseItem[] {
	const base: UseCaseItem[] = [{ value: 'all', label: 'All' }]
	if (!counts) return base
	return [
		...base,
		...Object.keys(counts.by_use_case)
			.sort()
			.map((key) => ({ value: key, label: key })),
	]
}

const SUBHEAD =
	'Vetted agents, triggers, skills, and integrations — install them on their own, or as packages wired end-to-end.'

function MarketplacePage() {
	const { workspaceId } = useWorkspace()
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
	const [useCaseFilter, setUseCaseFilter] = useState<UseCaseFilter>('all')

	const { data, isLoading, isError } = useCatalogPackages()
	const counts = data?.counts
	const packages = data?.packages ?? []
	const useCaseItems = useMemo(() => buildUseCaseItems(counts), [counts])

	// Fetch individual items for multi-type packages (bundles) so they can be
	// shown independently in the Agents / Triggers / etc. sections.
	const multiTypePkgIds = useMemo(
		() => packages.filter((p) => p.item_types.length > 1).map((p) => p.id),
		[packages],
	)
	const detailQueries = useQueries({
		queries: multiTypePkgIds.map((id) => ({
			queryKey: queryKeys.catalogPackages.detail(id),
			queryFn: () => api.catalogPackages.get(id),
		})),
	})
	const allItems = useMemo(() => detailQueries.flatMap((q) => q.data?.items ?? []), [detailQueries])

	// Item-level type counts for the sidebar (prefer item granularity once loaded).
	const itemCountsByType = useMemo(() => {
		const c: Partial<Record<CatalogItemType, number>> = {}
		for (const item of allItems) {
			const t = item.item_type as CatalogItemType
			c[t] = (c[t] ?? 0) + 1
		}
		return c
	}, [allItems])

	// Package lookup for use-case filtering of items.
	const packageById = useMemo(() => {
		const m = new Map<string, CatalogPackageSummary>()
		for (const pkg of packages) m.set(pkg.id, pkg)
		return m
	}, [packages])

	const filteredPackages = useMemo(
		() =>
			useCaseFilter === 'all' ? packages : packages.filter((pkg) => pkg.use_case === useCaseFilter),
		[packages, useCaseFilter],
	)

	const filteredItems = useMemo(
		() =>
			useCaseFilter === 'all'
				? allItems
				: allItems.filter((item) => packageById.get(item.package_id)?.use_case === useCaseFilter),
		[allItems, useCaseFilter, packageById],
	)

	const { data: installsData } = useInstalledPackages(workspaceId)
	const installsByPackage = useMemo(() => {
		const map = new Map<string, InstalledPackageRow>()
		for (const row of installsData?.installs ?? []) {
			map.set(row.sourcePackageId, row)
		}
		return map
	}, [installsData])

	const { data: installedItemsData } = useInstalledCatalogItems(workspaceId)
	const installedItemsById = useMemo(() => {
		const map = new Map<string, CatalogItemInstalledEntry>()
		for (const entry of installedItemsData?.items ?? []) {
			map.set(entry.catalog_item_id, entry)
		}
		return map
	}, [installedItemsData])

	const isEmpty = !isLoading && !isError && packages.length === 0

	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="mb-4 md:mb-6">
				<h1 className="text-lg font-semibold text-foreground">Marketplace</h1>
				<p className="mt-1 text-sm text-muted-foreground max-w-2xl">{SUBHEAD}</p>
			</div>

			<div className="flex flex-col md:flex-row md:gap-8 flex-1 min-h-0">
				{/* Mobile: horizontal chip strip. Hidden ≥md. */}
				<nav aria-label="Marketplace filters" className="md:hidden -mx-1 mb-4 flex flex-col gap-2">
					<ChipStrip
						items={TYPE_ITEMS}
						active={typeFilter}
						onSelect={(v) => setTypeFilter(v as TypeFilter)}
						counts={counts}
						itemCounts={itemCountsByType}
						kind="type"
					/>
					<ChipStrip
						items={useCaseItems}
						active={useCaseFilter}
						onSelect={(v) => setUseCaseFilter(v as UseCaseFilter)}
						counts={counts}
						itemCounts={itemCountsByType}
						kind="use_case"
					/>
				</nav>

				{/* Desktop sidebar. Hidden <md. */}
				<aside className="hidden md:block md:w-48 md:shrink-0">
					<SidebarGroup label="Type">
						{TYPE_ITEMS.map((item) => (
							<SidebarItem
								key={item.value}
								label={item.label}
								count={countForType(item.value, counts, itemCountsByType)}
								active={typeFilter === item.value}
								onClick={() => setTypeFilter(item.value)}
							/>
						))}
					</SidebarGroup>
					<SidebarGroup label="Use case">
						{useCaseItems.map((item) => (
							<SidebarItem
								key={item.value}
								label={item.label}
								count={countForUseCase(item.value, counts)}
								active={useCaseFilter === item.value}
								onClick={() => setUseCaseFilter(item.value)}
							/>
						))}
					</SidebarGroup>
				</aside>

				<section className="flex-1 min-w-0">
					{isError ? (
						<p className="text-sm text-muted-foreground">
							Couldn't load the catalog right now. Try refreshing.
						</p>
					) : isLoading ? (
						<p className="text-sm text-muted-foreground">Loading catalog…</p>
					) : isEmpty ? (
						<p className="text-sm text-muted-foreground">
							No packages yet — check back once Maskin publishes the first one.
						</p>
					) : (
						<PackageGrid
							packages={filteredPackages}
							items={filteredItems}
							typeFilter={typeFilter}
							workspaceId={workspaceId}
							installLookup={(id) => installsByPackage.get(id)}
							installedItemLookup={(id) => installedItemsById.get(id)}
						/>
					)}
				</section>
			</div>
		</div>
	)
}

function SidebarGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mb-4">
			<div className="px-2 mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<ul className="flex flex-col gap-0.5">{children}</ul>
		</div>
	)
}

function SidebarItem({
	label,
	count,
	active,
	onClick,
}: {
	label: string
	count: number | undefined
	active: boolean
	onClick: () => void
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
					active
						? 'bg-muted font-medium text-foreground'
						: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
				)}
			>
				<span>{label}</span>
				{typeof count === 'number' ? (
					<span
						className={cn(
							'text-xs tabular-nums',
							active ? 'text-muted-foreground' : 'text-muted-foreground/70',
						)}
					>
						{count}
					</span>
				) : null}
			</button>
		</li>
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
	counts: CatalogPackageCounts | undefined
	itemCounts: Partial<Record<CatalogItemType, number>>
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
							<span className={cn('ml-1.5 tabular-nums', isActive ? 'opacity-80' : 'opacity-60')}>
								{count}
							</span>
						) : null}
					</button>
				)
			})}
		</div>
	)
}

function countForType(
	value: TypeFilter,
	counts: CatalogPackageCounts | undefined,
	itemCounts: Partial<Record<CatalogItemType, number>>,
): number | undefined {
	if (!counts) return undefined
	if (value === 'all' || value === 'packages') return counts.total
	// Use item-level count once loaded; fall back to package-level count.
	return itemCounts[value as CatalogItemType] ?? counts.by_type[value as CatalogItemType] ?? 0
}

function countForUseCase(
	value: UseCaseFilter,
	counts: CatalogPackageCounts | undefined,
): number | undefined {
	if (!counts) return undefined
	if (value === 'all') return counts.total
	return counts.by_use_case[value] ?? 0
}
