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
}

/** Install/Fork/Remove action cluster for a marketplace loop — shared by the
 * catalog card and the loop detail page so both stay in sync. */
export function LoopInstallControls({ workspaceId, loop, install }: LoopInstallControlsProps) {
	const [forkOpen, setForkOpen] = useState(false)
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const forked = install ? !install.isLocked : false

	return (
		<>
			<div className="flex items-center justify-end gap-2">
				{!install ? (
					<InstallButton workspaceId={workspaceId} loopId={loop.id} />
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

			{forked && install ? (
				<p className="text-[11px] text-muted-foreground">{forkedHint(install)}</p>
			) : null}
		</>
	)
}

function forkedHint(install: InstalledLoopRow): string {
	if (!install.hasUpdate) return ''
	return `v${install.availableVersion} of the source is available. Your fork stays at v${install.installedVersion}.`
}
