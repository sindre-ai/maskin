import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { CatalogPackageSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { type InstallState, InstallStateBadge } from './install-state-badge'
import { TypeChip } from './type-chip'

export function PackageCard({
	pkg,
	installState,
	onInstall,
	className,
}: {
	pkg: CatalogPackageSummary
	installState?: InstallState
	onInstall?: (pkg: CatalogPackageSummary) => void
	className?: string
}) {
	const installed = !!installState
	return (
		<Card
			className={cn(
				'flex h-full flex-col gap-3 p-4 transition-colors hover:border-border-hover',
				className,
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-sm font-semibold text-foreground">{pkg.name}</h3>
					<p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{pkg.description}</p>
				</div>
				{installState && <InstallStateBadge state={installState} />}
			</div>

			{pkg.item_types.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{pkg.item_types.map((t) => (
						<TypeChip key={t} type={t} />
					))}
				</div>
			)}

			<div className="mt-auto flex items-center justify-between gap-2 pt-1">
				<span className="font-mono text-xs text-muted-foreground">v{pkg.version}</span>
				<Button
					type="button"
					size="sm"
					variant={installed ? 'outline' : 'default'}
					onClick={() => onInstall?.(pkg)}
					disabled={installed}
				>
					{installed ? 'Installed' : 'Install package'}
				</Button>
			</div>
		</Card>
	)
}
