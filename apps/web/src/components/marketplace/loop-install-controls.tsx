import { Button } from '@/components/ui/button'
import type { InstalledLoopRow, MarketplaceLoopSummary } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { InstallButton } from './install-button'
import { ROW_ACTION_CLASS, RowPill } from './marketplace-row'
import { UninstallDialog } from './uninstall-dialog'

interface LoopInstallControlsProps {
	workspaceId: string
	loop: MarketplaceLoopSummary
	install?: InstalledLoopRow
	/** Marketplace surface; the detail page passes `'detail'` so its installs
	 * carry a `source` marker on `loop_installed`. Catalogue default: absent. */
	source?: 'detail'
	/** Catalogue row (v16): state pills + one outline action (Add / Open) on one line. */
	row?: boolean
}

/** Install/Manage action cluster for a marketplace loop — shared by the catalog
 * card and the loop detail page so both stay in sync. Once installed the footer
 * reads `✓ Installed` with a `Manage` link (mockup 2596–2597); Fork and Remove
 * live in the detail page's `⋯` menu, which is the one place that owns the
 * destructive and branching actions. */
export function LoopInstallControls({
	workspaceId,
	loop,
	install,
	source,
	row = false,
}: LoopInstallControlsProps) {
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const forked = install ? !install.isLocked : false

	if (row) {
		return (
			<>
				{install && locked && install.hasUpdate ? (
					<RowPill tone="tint">v{install.availableVersion} available</RowPill>
				) : null}
				{install ? <RowPill>{forked ? 'Forked' : 'Added'}</RowPill> : null}
				{install ? (
					install.objectId ? (
						<Button asChild size="sm" variant="outline" className={ROW_ACTION_CLASS}>
							<Link
								to="/$workspaceId/loops/$loopId"
								params={{ workspaceId, loopId: install.objectId }}
							>
								Open
							</Link>
						</Button>
					) : (
						// Older installs carry no provisioned flow, so Open has nowhere to go.
						<Button
							size="sm"
							variant="outline"
							className={ROW_ACTION_CLASS}
							onClick={() => setUninstallOpen(true)}
						>
							Remove
						</Button>
					)
				) : (
					<InstallButton
						workspaceId={workspaceId}
						loopId={loop.id}
						label="Add"
						variant="outline"
						className={ROW_ACTION_CLASS}
						source={source}
					/>
				)}
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
			</>
		)
	}

	return (
		<>
			{/* This row is never itself positioned, so its empty space still opens
			    the card. Each control gets `relative` to individually paint above
			    the card's overlay link and catch its own click. */}
			<div className="flex flex-wrap items-center gap-2">
				{install ? (
					<>
						<span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
							<Check aria-hidden="true" className="size-3.5" />
							Installed
						</span>
						{install.objectId ? (
							<Button
								asChild
								size="sm"
								variant="secondary"
								className="relative ml-auto rounded-full font-semibold"
							>
								<Link
									to="/$workspaceId/loops/$loopId"
									params={{ workspaceId, loopId: install.objectId }}
								>
									Manage
								</Link>
							</Button>
						) : (
							// Older installs carry no provisioned loop object, so there is
							// nowhere for Manage to go — offer Remove instead of a dead link.
							<Button
								size="sm"
								variant="outline"
								className="relative ml-auto"
								onClick={() => setUninstallOpen(true)}
							>
								Remove
							</Button>
						)}
					</>
				) : (
					<div className="ml-auto">
						<InstallButton workspaceId={workspaceId} loopId={loop.id} source={source} />
					</div>
				)}
			</div>

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
