import { Badge } from '@/components/ui/badge'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { ItemInstallControls } from './item-install-controls'
import { ITEM_TYPE_LABEL } from './item-type-label'
import { MarketplaceDetailHeader } from './marketplace-detail-header'

interface MarketplaceItemDetailProps {
	workspaceId: string
	item: MarketplaceLoopItem
	parentLoop: MarketplaceLoopSummary
	install?: InstalledLoopRow
	installedEntity?: MarketplaceItemInstalledEntry
}

export function MarketplaceItemDetail({
	workspaceId,
	item,
	parentLoop,
	install,
	installedEntity,
}: MarketplaceItemDetailProps) {
	const locked = install?.isLocked ?? false
	const snapshot = item.item_snapshot
	const name = (snapshot.name as string) ?? 'Untitled'
	const description = (snapshot.description as string) ?? ''

	return (
		<div className="space-y-6">
			<MarketplaceDetailHeader
				kindLabel={ITEM_TYPE_LABEL[item.item_type]}
				name={name}
				description={description}
				badge={
					install ? (
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
					) : undefined
				}
				actions={
					<ItemInstallControls
						workspaceId={workspaceId}
						item={item}
						name={name}
						install={install}
						installedEntity={installedEntity}
					/>
				}
			/>

			<ItemSnapshotDetails item={item} />

			<Link
				to="/$workspaceId/marketplace/$loopId"
				params={{ workspaceId, loopId: parentLoop.id }}
				className="inline-block text-xs text-muted-foreground hover:text-foreground hover:underline"
			>
				Part of {parentLoop.name}
			</Link>
		</div>
	)
}

/** A handful of read-only, type-specific fields pulled from the frozen
 * `item_snapshot` — not a clone of the live editor, just enough to preview
 * what this item is before installing it. */
function ItemSnapshotDetails({ item }: { item: MarketplaceLoopItem }) {
	const rows = snapshotRows(item)
	if (rows.length === 0) return null

	return (
		<div>
			<h2 className="mb-3 text-sm font-semibold text-foreground">Details</h2>
			<div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4">
				{rows.map(([label, value]) => (
					<div key={label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
						<span className="w-32 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
						<span className="min-w-0 flex-1 text-sm break-words text-foreground">{value}</span>
					</div>
				))}
			</div>
		</div>
	)
}

function snapshotRows(item: MarketplaceLoopItem): [string, string][] {
	const snapshot = item.item_snapshot as Record<string, unknown>
	const rows: [string, string][] = []
	const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

	switch (item.item_type) {
		case 'actor': {
			const provider = str(snapshot.llm_provider) ?? str(snapshot.llmProvider)
			if (provider) rows.push(['LLM provider', provider])
			const prompt = str(snapshot.system_prompt) ?? str(snapshot.systemPrompt)
			if (prompt)
				rows.push(['System prompt', prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt])
			break
		}
		case 'trigger': {
			const type = str(snapshot.type)
			if (type) rows.push(['Trigger type', type])
			const prompt = str(snapshot.action_prompt) ?? str(snapshot.actionPrompt)
			if (prompt) rows.push(['Action', prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt])
			break
		}
		case 'skill': {
			const content = str(snapshot.content)
			if (content)
				rows.push(['Content', content.length > 240 ? `${content.slice(0, 240)}…` : content])
			break
		}
		case 'integration': {
			const provider = str(snapshot.provider)
			if (provider) rows.push(['Provider', provider])
			break
		}
		case 'extension': {
			const extensionId = str(snapshot.extensionId) ?? str(snapshot.extension_id)
			if (extensionId) rows.push(['Extension', extensionId])
			break
		}
	}

	return rows
}
