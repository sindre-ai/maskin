import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CatalogPackageSummary, InstalledPackageRow } from '@/lib/api'
import { useState } from 'react'
import { ForkDialog } from './fork-dialog'
import { InstallButton } from './install-button'
import { UninstallDialog } from './uninstall-dialog'
import { UpdateAvailableBanner } from './update-available-banner'

interface PackageCardProps {
	workspaceId: string
	pkg: CatalogPackageSummary
	install?: InstalledPackageRow
}

export function PackageCard({ workspaceId, pkg, install }: PackageCardProps) {
	const [forkOpen, setForkOpen] = useState(false)
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const forked = install ? !install.isLocked : false
	const showUpdateBanner = locked && install?.hasUpdate === true

	return (
		<article className="flex flex-col gap-[var(--space-3)] rounded-lg border border-border bg-background p-[var(--space-4)] shadow-sm">
			<div className="flex items-start justify-between gap-[var(--space-3)]">
				<div className="min-w-0">
					<h3 className="text-label font-semibold text-foreground">{pkg.name}</h3>
					<p className="mt-[var(--space-1)] text-caption text-muted-foreground line-clamp-2">
						{pkg.description}
					</p>
				</div>
				{install ? (
					locked ? (
						<Badge
							variant="secondary"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium"
						>
							🔒 Managed · v{install.installedVersion}
						</Badge>
					) : (
						<Badge
							variant="outline"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium text-foreground"
						>
							⑂ Forked from v{install.installedVersion}
						</Badge>
					)
				) : null}
			</div>

			<div className="flex flex-wrap gap-[var(--space-1)]">
				{pkg.item_types.map((type) => (
					<span
						key={type}
						className="rounded-full border border-border bg-muted/40 px-[var(--space-2)] py-[2px] text-eyebrow font-medium uppercase text-muted-foreground"
					>
						{type}
					</span>
				))}
			</div>

			{showUpdateBanner ? <UpdateAvailableBanner newVersion={install.availableVersion} /> : null}

			<div className="mt-auto flex items-center justify-end gap-[var(--space-2)]">
				{!install ? (
					<InstallButton workspaceId={workspaceId} packageId={pkg.id} />
				) : (
					<>
						{locked && (
							<Button size="sm" variant="outline" onClick={() => setForkOpen(true)}>
								Fork
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							className="text-muted-foreground hover:text-error"
							onClick={() => setUninstallOpen(true)}
						>
							Remove
						</Button>
					</>
				)}
			</div>

			{install && locked ? (
				<ForkDialog
					open={forkOpen}
					onOpenChange={setForkOpen}
					workspaceId={workspaceId}
					installedPackageId={install.id}
					packageName={pkg.name}
					installedVersion={install.installedVersion}
					pendingVersion={install.hasUpdate ? install.availableVersion : null}
				/>
			) : null}

			{install ? (
				<UninstallDialog
					open={uninstallOpen}
					onOpenChange={setUninstallOpen}
					workspaceId={workspaceId}
					installedPackageId={install.id}
					packageName={pkg.name}
					isLocked={locked}
				/>
			) : null}

			{forked && install ? (
				<p className="text-[11px] text-muted-foreground">{forkedHint(install)}</p>
			) : null}
		</article>
	)
}

function forkedHint(install: InstalledPackageRow): string {
	if (!install.hasUpdate) return ''
	return `v${install.availableVersion} of the source is available. Your fork stays at v${install.installedVersion}.`
}
