import { Badge } from '@/components/ui/badge'
import type { CatalogItemType, CatalogPackageItem, InstalledPackageRow } from '@/lib/api'
import { InstallButton } from './install-button'

const TYPE_LABEL: Record<CatalogItemType, string> = {
	actor: 'Agent',
	trigger: 'Trigger',
	skill: 'Skill',
	integration: 'Integration',
}

interface ItemCardProps {
	workspaceId: string
	item: CatalogPackageItem
	install?: InstalledPackageRow
}

export function ItemCard({ workspaceId, item, install }: ItemCardProps) {
	const snapshot = item.item_snapshot
	const name = (snapshot.name as string) ?? 'Untitled'
	const description = (snapshot.description as string) ?? null
	const locked = install?.isLocked ?? false

	return (
		<article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-sm">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{name}</h3>
					{description && (
						<p className="mt-1 text-xs text-muted-foreground line-clamp-2">{description}</p>
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

			<div className="flex flex-wrap gap-1">
				<span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					{TYPE_LABEL[item.item_type]}
				</span>
			</div>

			<div className="mt-auto flex items-center justify-end gap-2">
				{!install && (
					<InstallButton workspaceId={workspaceId} packageId={item.package_id} label="Install" />
				)}
			</div>
		</article>
	)
}
