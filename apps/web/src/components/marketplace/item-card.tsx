import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useInstallCatalogItem, useUninstallCatalogItem } from '@/hooks/use-catalog-packages'
import type {
	CatalogItemInstalledEntry,
	CatalogItemType,
	CatalogPackageItem,
	InstalledPackageRow,
} from '@/lib/api'
import { useState } from 'react'
import { UninstallDialog } from './uninstall-dialog'

const TYPE_LABEL: Record<CatalogItemType, string> = {
	actor: 'Agent',
	trigger: 'Trigger',
	skill: 'Skill',
	integration: 'Integration',
}

interface ItemCardProps {
	workspaceId: string
	item: CatalogPackageItem
	/** Set when the whole parent package is installed — suppresses individual install/remove. */
	install?: InstalledPackageRow
	/** Set when this specific item was individually installed. */
	installedEntity?: CatalogItemInstalledEntry
}

export function ItemCard({ workspaceId, item, install, installedEntity }: ItemCardProps) {
	const snapshot = item.item_snapshot
	const name = (snapshot.name as string) ?? 'Untitled'
	const description = (snapshot.description as string) ?? null
	const locked = install?.isLocked ?? false

	const installMutation = useInstallCatalogItem(workspaceId)
	const uninstallMutation = useUninstallCatalogItem(workspaceId)
	const [removeOpen, setRemoveOpen] = useState(false)

	// Compute installed state across sessions (server data) and within the session (mutation state).
	const isCurrentlyInstalled =
		(!!installedEntity || installMutation.isSuccess) && !uninstallMutation.isSuccess

	return (
		<article className="flex flex-col gap-[var(--space-3)] rounded-lg border border-border bg-background p-[var(--space-4)] shadow-sm">
			<div className="flex items-start justify-between gap-[var(--space-3)]">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{name}</h3>
					{description && (
						<p className="mt-[var(--space-1)] text-xs text-muted-foreground line-clamp-2">
							{description}
						</p>
					)}
				</div>
				{install ? (
					locked ? (
						<Badge
							variant="secondary"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium"
						>
							🔒 Managed
						</Badge>
					) : (
						<Badge
							variant="outline"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium text-foreground"
						>
							⑂ Forked
						</Badge>
					)
				) : null}
			</div>

			<div className="flex flex-wrap gap-[var(--space-1)]">
				<span className="rounded-full border border-border bg-muted/40 px-[var(--space-2)] py-[2px] text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					{TYPE_LABEL[item.item_type]}
				</span>
			</div>

			<div className="mt-auto flex items-center justify-end gap-[var(--space-2)]">
				{!install &&
					(isCurrentlyInstalled ? (
						<>
							<Badge variant="secondary" className="text-[11px] font-medium">
								Installed
							</Badge>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 text-xs text-muted-foreground hover:text-destructive"
								onClick={() => setRemoveOpen(true)}
							>
								Remove
							</Button>
							<UninstallDialog
								open={removeOpen}
								onOpenChange={setRemoveOpen}
								workspaceId={workspaceId}
								packageName={name}
								isLocked={false}
								onConfirm={(keepItems) => {
									uninstallMutation.mutate(
										{ itemId: item.id, keepProvisionedItems: keepItems },
										{ onSuccess: () => setRemoveOpen(false) },
									)
								}}
								confirmPending={uninstallMutation.isPending}
							/>
						</>
					) : (
						<Button
							size="sm"
							variant="default"
							className="h-7 text-xs"
							disabled={installMutation.isPending}
							onClick={() => installMutation.mutate(item.id)}
						>
							{installMutation.isPending ? 'Installing…' : 'Install'}
						</Button>
					))}
			</div>
		</article>
	)
}
