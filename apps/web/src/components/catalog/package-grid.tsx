import { ItemCard } from '@/components/marketplace/item-card'
import { PackageCard } from '@/components/marketplace/package-card'
import type {
	CatalogItemInstalledEntry,
	CatalogItemType,
	CatalogPackageItem,
	CatalogPackageSummary,
	InstalledPackageRow,
} from '@/lib/api'
import { cn } from '@/lib/cn'

type TypeFilter = 'all' | 'packages' | CatalogItemType

const SECTION_ORDER: CatalogItemType[] = ['actor', 'trigger', 'skill', 'integration']

const SECTION_TITLE: Record<CatalogItemType, string> = {
	actor: 'Agents',
	trigger: 'Triggers',
	skill: 'Skills',
	integration: 'Integrations',
}

export function PackageGrid({
	packages,
	items = [],
	typeFilter,
	workspaceId,
	installLookup,
	installedItemLookup,
	className,
}: {
	packages: CatalogPackageSummary[]
	items?: CatalogPackageItem[]
	/** Controls which sections are rendered. Defaults to 'all'. */
	typeFilter?: TypeFilter
	workspaceId: string
	/** Receives a package or item's parent-package ID and returns its install row. */
	installLookup?: (id: string) => InstalledPackageRow | undefined
	/** Receives a catalog item ID and returns its individual-install entry. */
	installedItemLookup?: (itemId: string) => CatalogItemInstalledEntry | undefined
	className?: string
}) {
	const filter = typeFilter ?? 'all'

	// Multi-type packages (bundles) go in the "Packages" section.
	// Single-type packages go in their matching typed section as package cards.
	const multiTypePkgs = packages.filter((p) => p.item_types.length > 1)
	const singleTypePkgs = packages.filter((p) => p.item_types.length === 1)

	// Group items by their source package so bundle cards can render a
	// composition chip row without re-fetching what the route already loaded.
	const itemsByPackage = new Map<string, CatalogPackageItem[]>()
	for (const item of items) {
		const list = itemsByPackage.get(item.package_id)
		if (list) list.push(item)
		else itemsByPackage.set(item.package_id, [item])
	}

	const showPackagesSection = filter === 'all' || filter === 'packages'
	const typesToShow: CatalogItemType[] =
		filter === 'packages' ? [] : filter === 'all' ? SECTION_ORDER : [filter as CatalogItemType]

	const typedSections = typesToShow
		.map((type) => ({
			type,
			pkgCards: singleTypePkgs.filter((p) => p.item_types.includes(type)),
			itemCards: items.filter((i) => i.item_type === type),
		}))
		.filter((s) => s.pkgCards.length > 0 || s.itemCards.length > 0)

	const hasPackages = showPackagesSection && multiTypePkgs.length > 0
	if (!hasPackages && typedSections.length === 0) return null

	return (
		<div className={cn('space-y-8', className)}>
			{hasPackages && (
				<section className="space-y-3" aria-label="Packages">
					<h2 className="text-sm font-semibold text-foreground">Packages</h2>
					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
						{multiTypePkgs.map((pkg) => (
							<PackageCard
								key={pkg.id}
								workspaceId={workspaceId}
								pkg={pkg}
								install={installLookup?.(pkg.id)}
								items={itemsByPackage.get(pkg.id)}
							/>
						))}
					</div>
				</section>
			)}
			{typedSections.map(({ type, pkgCards, itemCards }) => (
				<section key={type} className="space-y-3" aria-label={SECTION_TITLE[type]}>
					<h2 className="text-sm font-semibold text-foreground">{SECTION_TITLE[type]}</h2>
					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
						{pkgCards.map((pkg) => (
							<PackageCard
								key={pkg.id}
								workspaceId={workspaceId}
								pkg={pkg}
								install={installLookup?.(pkg.id)}
							/>
						))}
						{itemCards.map((item) => (
							<ItemCard
								key={item.id}
								workspaceId={workspaceId}
								item={item}
								install={installLookup?.(item.package_id)}
								installedEntity={installedItemLookup?.(item.id)}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	)
}
