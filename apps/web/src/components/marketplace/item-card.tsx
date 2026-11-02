import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceLoopItem,
} from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { ItemInstallControls } from './item-install-controls'
import { MarketplaceRow, RowPill } from './marketplace-row'

interface ItemCardProps {
	workspaceId: string
	item: MarketplaceLoopItem
	/** Set when the whole parent loop is installed — suppresses individual install/remove. */
	install?: InstalledLoopRow
	/** Set when this specific item was individually installed. */
	installedEntity?: MarketplaceItemInstalledEntry
}

export function ItemCard({ workspaceId, item, install, installedEntity }: ItemCardProps) {
	const snapshot = item.item_snapshot
	const name = (snapshot.name as string) ?? 'Untitled'
	const description = (snapshot.description as string) ?? null

	return (
		<MarketplaceRow
			name={name}
			description={description}
			overlay={
				<Link
					to="/$workspaceId/marketplace/$loopId/$itemId"
					params={{ workspaceId, loopId: item.loop_id, itemId: item.id }}
					className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={`Open ${name}`}
				/>
			}
			// Items that arrive through an installed parent flow show the flow's state.
			status={install ? <RowPill>{install.isLocked ? 'Added' : 'Forked'}</RowPill> : null}
			action={
				<ItemInstallControls
					row
					workspaceId={workspaceId}
					item={item}
					name={name}
					install={install}
					installedEntity={installedEntity}
				/>
			}
		/>
	)
}
