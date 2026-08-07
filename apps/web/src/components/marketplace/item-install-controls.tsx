import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	useInstallMarketplaceItem,
	useUninstallMarketplaceItem,
} from '@/hooks/use-marketplace-loops'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceLoopItem,
} from '@/lib/api'
import { useState } from 'react'
import { UninstallDialog } from './uninstall-dialog'

interface ItemInstallControlsProps {
	workspaceId: string
	item: MarketplaceLoopItem
	name: string
	/** Set when the whole parent loop is installed — suppresses individual install/remove. */
	install?: InstalledLoopRow
	/** Set when this specific item was individually installed. */
	installedEntity?: MarketplaceItemInstalledEntry
}

/** Install/Remove action cluster for a single marketplace item — shared by
 * the catalog card and the item detail page so both stay in sync. */
export function ItemInstallControls({
	workspaceId,
	item,
	name,
	install,
	installedEntity,
}: ItemInstallControlsProps) {
	const installMutation = useInstallMarketplaceItem(workspaceId)
	const uninstallMutation = useUninstallMarketplaceItem(workspaceId)
	const [removeOpen, setRemoveOpen] = useState(false)

	// Compute installed state across sessions (server data) and within the session (mutation state).
	const isCurrentlyInstalled =
		(!!installedEntity || installMutation.isSuccess) && !uninstallMutation.isSuccess

	if (install) return null

	return (
		// This row is never itself positioned, so its empty space still opens
		// the card. Each button gets `relative` to individually paint above
		// the card's overlay link and catch its own click.
		<div className="flex items-center justify-end gap-2">
			{isCurrentlyInstalled ? (
				<>
					<Badge variant="secondary" className="text-[11px] font-medium">
						Installed
					</Badge>
					<Button
						size="sm"
						variant="ghost"
						className="relative h-7 text-xs text-muted-foreground hover:text-destructive"
						onClick={() => setRemoveOpen(true)}
					>
						Remove
					</Button>
					<UninstallDialog
						open={removeOpen}
						onOpenChange={setRemoveOpen}
						workspaceId={workspaceId}
						loopName={name}
						isLocked={false}
						onConfirm={(keepItems) => {
							uninstallMutation.mutate(
								{ itemId: item.id, keepProvisionedItems: keepItems },
								{
									onSuccess: () => {
										setRemoveOpen(false)
										// Clear a stale install success flag so a later re-install
										// isn't immediately masked by this uninstall's own state.
										installMutation.reset()
									},
								},
							)
						}}
						confirmPending={uninstallMutation.isPending}
					/>
				</>
			) : (
				<Button
					size="sm"
					variant="default"
					className="relative h-7 text-xs"
					disabled={installMutation.isPending}
					onClick={() => {
						// Clear a stale uninstall success flag — otherwise re-installing
						// after a remove keeps rendering the "Install" button.
						uninstallMutation.reset()
						installMutation.mutate(item.id)
					}}
				>
					{installMutation.isPending ? 'Installing…' : 'Install'}
				</Button>
			)}
		</div>
	)
}
