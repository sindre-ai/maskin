import { Badge } from '@/components/ui/badge'
import type {
	InstalledLoopRow,
	MarketplaceItemInstalledEntry,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { ItemInstallControls } from './item-install-controls'
import { MarketplaceBreadcrumb } from './marketplace-breadcrumb'
import { MarketplaceDetailHeader } from './marketplace-detail-header'
import { PermissionsSection, RunsSection } from './marketplace-disclosure'

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
	const isInstalled = Boolean(install || installedEntity)

	return (
		// Same shape as the loop detail: the action bar stays out of the scroll
		// region so Install and the breadcrumb are reachable without scrolling.
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border pb-3">
				<MarketplaceBreadcrumb
					workspaceId={workspaceId}
					items={[
						{
							label: parentLoop.name,
							to: '/$workspaceId/marketplace/$loopId',
							params: { workspaceId, loopId: parentLoop.id },
						},
						{ label: name },
					]}
				/>
				<div className="ml-auto flex shrink-0 items-center gap-2">
					<ItemInstallControls
						workspaceId={workspaceId}
						item={item}
						name={name}
						install={install}
						installedEntity={installedEntity}
					/>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-7 py-6">
					<MarketplaceDetailHeader
						kind={item.item_type}
						name={name}
						description={description}
						badge={
							isInstalled ? (
								<div className="flex shrink-0 flex-wrap items-center gap-2">
									<Badge className="gap-1.5 whitespace-nowrap border-transparent bg-status-active-bg text-[12px] font-semibold text-status-active-text">
										<Check aria-hidden="true" className="size-3.5" />
										Installed
									</Badge>
									{install ? (
										locked ? (
											<Badge
												variant="secondary"
												className="whitespace-nowrap text-[11px] font-medium"
											>
												🔒 Managed
											</Badge>
										) : (
											<Badge
												variant="outline"
												className="whitespace-nowrap text-[11px] font-medium text-foreground"
											>
												⑂ Forked
											</Badge>
										)
									) : null}
								</div>
							) : undefined
						}
					/>

					<RunsSection rows={runsRows(item)} />
					<ItemSnapshotDetails item={item} />
					<PermissionsSection pills={permissionPills(item)} />

					<Link
						to="/$workspaceId/marketplace/$loopId"
						params={{ workspaceId, loopId: parentLoop.id }}
						className="inline-block text-xs text-muted-foreground hover:text-foreground hover:underline"
					>
						Part of {parentLoop.name}
					</Link>
				</div>
			</div>
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
			<div className="mb-3 flex items-center gap-2.5">
				<h2 className="shrink-0 text-sm font-bold text-foreground">Details</h2>
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
			</div>
			<div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
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

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** "How it runs" for a single item — only the runtime facts the snapshot
 * actually carries (mockup 2701–2706 applies to every kind). */
function runsRows(item: MarketplaceLoopItem): { label: string; value: string }[] {
	const snapshot = item.item_snapshot as Record<string, unknown>
	const rows: { label: string; value: string }[] = []

	switch (item.item_type) {
		case 'actor': {
			const provider = str(snapshot.llm_provider) ?? str(snapshot.llmProvider)
			if (provider) rows.push({ label: 'LLM provider', value: provider })
			const config = (snapshot.llmConfig ?? snapshot.llm_config ?? {}) as Record<string, unknown>
			const model = str(config.model)
			if (model) rows.push({ label: 'Model', value: model })
			break
		}
		case 'trigger': {
			const type = str(snapshot.type)
			if (type) rows.push({ label: 'Trigger type', value: type })
			break
		}
		case 'integration': {
			const provider = str(snapshot.provider)
			if (provider) rows.push({ label: 'Provider', value: provider })
			break
		}
		case 'skill':
			break
	}

	return rows
}

/** Permission pills for a single item — the scope every install is bound to,
 * plus the MCP surfaces or provider the snapshot declares. */
function permissionPills(item: MarketplaceLoopItem): string[] {
	const snapshot = item.item_snapshot as Record<string, unknown>
	const pills = ['This workspace only']

	if (item.item_type === 'actor') {
		const toolConfig = snapshot.tools
		if (toolConfig && typeof toolConfig === 'object' && !Array.isArray(toolConfig)) {
			const servers = (toolConfig as Record<string, unknown>).mcpServers
			if (servers && typeof servers === 'object') {
				pills.push(...Object.keys(servers as Record<string, unknown>))
			}
		}
	}
	if (item.item_type === 'integration') {
		const provider = str(snapshot.provider)
		if (provider) pills.push(provider)
	}

	return pills
}

function snapshotRows(item: MarketplaceLoopItem): [string, string][] {
	const snapshot = item.item_snapshot as Record<string, unknown>
	const rows: [string, string][] = []

	switch (item.item_type) {
		case 'actor': {
			const prompt = str(snapshot.system_prompt) ?? str(snapshot.systemPrompt)
			if (prompt)
				rows.push(['System prompt', prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt])
			break
		}
		case 'trigger': {
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
		case 'integration':
			break
	}

	return rows
}
