import { PackageCard } from '@/components/marketplace/package-card'
import type { CatalogItemType, CatalogPackageSummary, InstalledPackageRow } from '@/lib/api'
import { cn } from '@/lib/cn'

const SECTION_ORDER: CatalogItemType[] = ['actor', 'trigger', 'skill', 'integration']

const SECTION_TITLE: Record<CatalogItemType, string> = {
	actor: 'Agents',
	trigger: 'Triggers',
	skill: 'Skills',
	integration: 'Integrations',
}

export function PackageGrid({
	packages,
	activeType,
	workspaceId,
	installLookup,
	className,
}: {
	packages: CatalogPackageSummary[]
	/** When set, render only this type's section instead of one per item_type. */
	activeType?: CatalogItemType
	workspaceId: string
	installLookup?: (pkg: CatalogPackageSummary) => InstalledPackageRow | undefined
	className?: string
}) {
	const order = activeType ? [activeType] : SECTION_ORDER
	const sections = order
		.map((type) => ({
			type,
			packages: packages.filter((p) => p.item_types.includes(type)),
		}))
		.filter((s) => s.packages.length > 0)

	if (sections.length === 0) return null

	return (
		<div className={cn('space-y-8', className)}>
			{sections.map(({ type, packages: bucket }) => (
				<section key={type} className="space-y-3" aria-label={SECTION_TITLE[type]}>
					<h2 className="text-sm font-semibold text-foreground">{SECTION_TITLE[type]}</h2>
					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
						{bucket.map((pkg) => (
							<PackageCard
								key={pkg.id}
								workspaceId={workspaceId}
								pkg={pkg}
								install={installLookup?.(pkg)}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	)
}
