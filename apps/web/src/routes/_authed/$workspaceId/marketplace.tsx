import { PackageGrid } from '@/components/catalog/package-grid'
import { RouteError } from '@/components/shared/route-error'
import { useCatalogPackages } from '@/hooks/use-catalog-packages'
import type { CatalogItemType, CatalogPackageCounts, CatalogPackageSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

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

const USE_CASE_ITEMS: UseCaseItem[] = [
	{ value: 'all', label: 'All' },
	{ value: 'Discovery', label: 'Discovery' },
	{ value: 'Sales', label: 'Sales' },
	{ value: 'Research', label: 'Research' },
	{ value: 'Lifecycle comms', label: 'Lifecycle comms' },
]

const SUBHEAD =
	'Vetted agents, triggers, skills, and integrations — install them on their own, or as packages wired end-to-end.'

function MarketplacePage() {
	useWorkspace()
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
	const [useCaseFilter, setUseCaseFilter] = useState<UseCaseFilter>('all')

	const { data, isLoading, isError } = useCatalogPackages()
	const counts = data?.counts

	const handleInstall = (pkg: CatalogPackageSummary) => {
		// T9 wires the install mutation. Keeps the success path observable here.
		console.info('[marketplace] install requested', { id: pkg.id, slug: pkg.slug })
	}

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
						kind="type"
					/>
					<ChipStrip
						items={USE_CASE_ITEMS}
						active={useCaseFilter}
						onSelect={(v) => setUseCaseFilter(v as UseCaseFilter)}
						counts={counts}
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
								count={countForType(item.value, counts)}
								active={typeFilter === item.value}
								onClick={() => setTypeFilter(item.value)}
							/>
						))}
					</SidebarGroup>
					<SidebarGroup label="Use case">
						{USE_CASE_ITEMS.map((item) => (
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
					) : (
						<PackageGrid
							packages={filterPackages(data?.packages ?? [], typeFilter, useCaseFilter)}
							onInstall={handleInstall}
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
			<div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
					'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
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
	kind,
}: {
	items: (TypeItem | UseCaseItem)[]
	active: string
	onSelect: (value: string) => void
	counts: CatalogPackageCounts | undefined
	kind: 'type' | 'use_case'
}) {
	return (
		<div className="flex gap-1.5 overflow-x-auto px-1 pb-1">
			{items.map((item) => {
				const count =
					kind === 'type'
						? countForType(item.value as TypeFilter, counts)
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
): number | undefined {
	if (!counts) return undefined
	if (value === 'all' || value === 'packages') return counts.total
	return counts.by_type[value] ?? 0
}

function countForUseCase(
	value: UseCaseFilter,
	counts: CatalogPackageCounts | undefined,
): number | undefined {
	if (!counts) return undefined
	if (value === 'all') return counts.total
	return counts.by_use_case[value] ?? 0
}

function filterPackages(
	packages: CatalogPackageSummary[],
	typeFilter: TypeFilter,
	useCaseFilter: UseCaseFilter,
): CatalogPackageSummary[] {
	return packages.filter((pkg) => {
		if (typeFilter !== 'all' && typeFilter !== 'packages') {
			if (!pkg.item_types.includes(typeFilter)) return false
		}
		if (useCaseFilter !== 'all') {
			if (pkg.use_case !== useCaseFilter) return false
		}
		return true
	})
}
