import { PackageCard } from '@/components/marketplace/package-card'
import type { CatalogPackageSummary, InstalledPackageRow } from '@/lib/api'
import { cn } from '@/lib/cn'

export function FeaturedStrip({
	packages,
	workspaceId,
	installLookup,
	className,
}: {
	packages: CatalogPackageSummary[]
	workspaceId: string
	installLookup?: (pkg: CatalogPackageSummary) => InstalledPackageRow | undefined
	className?: string
}) {
	const featured = packages.filter((p) => p.is_featured)
	if (featured.length === 0) return null

	return (
		<section className={cn('space-y-3', className)} aria-label="Featured">
			<h2 className="text-sm font-semibold text-foreground">Featured</h2>
			<div className="-mx-1 overflow-x-auto pb-1">
				<ul className="flex snap-x snap-mandatory gap-3 px-1">
					{featured.map((pkg) => (
						<li key={pkg.id} className="w-72 shrink-0 snap-start sm:w-80">
							<PackageCard workspaceId={workspaceId} pkg={pkg} install={installLookup?.(pkg)} />
						</li>
					))}
				</ul>
			</div>
		</section>
	)
}
