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
	// Forking detaches the rows an install provisioned so the workspace can edit
	// them freely. An extension provisions no rows — it flips a key in workspace
	// settings — so there is nothing for a fork to take ownership of, and the
	// resulting install would just stop receiving version pushes for no gain.
	const canFork = !extensionOnly(loop)

	return (
		<>
			{/* This row is never itself positioned, so its empty space still opens
			    the card. Each button gets `relative` to individually paint above
			    the card's overlay link and catch its own click. */}
			<div className="flex items-center justify-end gap-2">
				{!install ? (
					<InstallButton workspaceId={workspaceId} loopId={loop.id} label={installLabel(loop)} />
				) : (
					<>
						{locked && canFork && (
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

			{install && locked && canFork ? (
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

/**
 * Whether this loop's entire content is extensions. Such a loop isn't a loop in
 * any sense the user cares about, so it reads as the extension it installs
 * rather than as a bundle. A loop that ships an extension *alongside* agents or
 * triggers is a real loop and is treated as one.
 */
function extensionOnly(loop: MarketplaceLoopSummary): boolean {
	return loop.item_types.length > 0 && loop.item_types.every((type) => type === 'extension')
}

/** "Install loop" on the Work Extension card reads as a mistake — name the
 * thing actually being installed. */
function installLabel(loop: MarketplaceLoopSummary): string {
	return extensionOnly(loop) ? 'Install extension' : 'Install loop'
}

function forkedHint(install: InstalledLoopRow): string {
	return `v${install.availableVersion} of the source is available. Your fork stays at v${install.installedVersion}.`
}
