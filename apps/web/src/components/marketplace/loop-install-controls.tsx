import { Button } from '@/components/ui/button'
import type { InstalledLoopRow, MarketplaceLoopSummary } from '@/lib/api'
import { useState } from 'react'
import { ForkDialog } from './fork-dialog'
import { InstallButton } from './install-button'
import { UninstallDialog } from './uninstall-dialog'

interface LoopInstallControlsProps {
	workspaceId: string
	loop: MarketplaceLoopSummary
	install?: InstalledLoopRow
	/** Marketplace surface; the detail page passes `'detail'` so its installs
	 * carry a `source` marker on `loop_installed`. Catalogue default: absent. */
	source?: 'detail'
}

/** Install/Fork/Remove action cluster for a marketplace loop — shared by the
 * catalog card and the loop detail page so both stay in sync. */
export function LoopInstallControls({
	workspaceId,
	loop,
	install,
	source,
}: LoopInstallControlsProps) {
	const [forkOpen, setForkOpen] = useState(false)
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const forked = install ? !install.isLocked : false

	return (
		<>
			{/* This row is never itself positioned, so its empty space still opens
			    the card. Each button gets `relative` to individually paint above
			    the card's overlay link and catch its own click. */}
			<div className="flex items-center justify-end gap-2">
				{!install ? (
					<InstallButton workspaceId={workspaceId} loopId={loop.id} source={source} />
				) : (
					<>
						{locked && (
							<Button
								size="sm"
								variant="outline"
								className="relative"
								onClick={() => setForkOpen(true)}
							>
								Fork
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							className="relative text-muted-foreground hover:text-error"
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
					installedLoopId={install.id}
					loopName={loop.name}
					installedVersion={install.installedVersion}
					pendingVersion={install.hasUpdate ? install.availableVersion : null}
				/>
			) : null}

			{install ? (
				<UninstallDialog
					open={uninstallOpen}
					onOpenChange={setUninstallOpen}
					workspaceId={workspaceId}
					installedLoopId={install.id}
					loopName={loop.name}
					isLocked={locked}
				/>
			) : null}

			{forked && install?.hasUpdate ? (
				<p className="text-[11px] text-muted-foreground">{forkedHint(install)}</p>
			) : null}
		</>
	)
}

function forkedHint(install: InstalledLoopRow): string {
	return `v${install.availableVersion} of the source is available. Your fork stays at v${install.installedVersion}.`
}
