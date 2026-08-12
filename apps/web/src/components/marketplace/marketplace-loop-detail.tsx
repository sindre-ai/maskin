import { MarketplaceBreadcrumb } from '@/components/marketplace/marketplace-breadcrumb'
import { describeTrigger } from '@/components/triggers/trigger-row'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUninstallLoop } from '@/hooks/use-installed-loops'
import type { InstalledLoopRow, MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { stepAsksYou } from '@/lib/marketplace-asks'
import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { ForkDialog } from './fork-dialog'
import { InstallButton } from './install-button'
import { ITEM_TYPE_LABEL } from './item-type-label'
import { MarketplaceDetailHeader } from './marketplace-detail-header'
import { AsksSection, FlowSection, PermissionsSection, RunsSection } from './marketplace-disclosure'

interface MarketplaceLoopDetailProps {
	workspaceId: string
	loop: MarketplaceLoopSummary
	items: MarketplaceLoopItem[]
	install?: InstalledLoopRow
}

export function MarketplaceLoopDetail({
	workspaceId,
	loop,
	items,
	install,
}: MarketplaceLoopDetailProps) {
	const locked = install?.isLocked ?? false
	const kindLabel =
		loop.item_types.length === 1 ? ITEM_TYPE_LABEL[loop.item_types[0]] : 'Loop bundle'

	return (
		<div className="space-y-8">
			<MarketplaceBreadcrumb
				workspaceId={workspaceId}
				items={[{ label: 'Loops' }, { label: loop.name }]}
			/>

			<MarketplaceDetailHeader
				kindLabel={kindLabel}
				name={loop.name}
				description={loop.description}
				badge={
					install ? (
						locked ? (
							<Badge
								variant="secondary"
								className="shrink-0 whitespace-nowrap text-[11px] font-medium"
							>
								🔒 Managed · v{install.installedVersion}
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="shrink-0 whitespace-nowrap text-[11px] font-medium text-foreground"
							>
								⑂ Forked from v{install.installedVersion}
							</Badge>
						)
					) : undefined
				}
				actions={<HeaderActions workspaceId={workspaceId} loop={loop} install={install} />}
			/>

			<LoopFlow workspaceId={workspaceId} loop={loop} items={items} />
		</div>
	)
}

function HeaderActions({
	workspaceId,
	loop,
	install,
}: {
	workspaceId: string
	loop: MarketplaceLoopSummary
	install?: InstalledLoopRow
}) {
	const [forkOpen, setForkOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const uninstall = useUninstallLoop(workspaceId)

	// Not installed — the primary Install is the only action.
	if (!install) {
		return <InstallButton workspaceId={workspaceId} loopId={loop.id} source="detail" />
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Loop actions">
						<MoreHorizontal size={16} />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{locked ? (
						<>
							<DropdownMenuLabel>Loop actions</DropdownMenuLabel>
							<DropdownMenuItem onSelect={() => setForkOpen(true)}>Fork this loop</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					) : null}
					<DropdownMenuItem
						className="text-error focus:text-error"
						onSelect={() =>
							uninstall.mutate({ installedLoopId: install.id, keepProvisionedItems: false })
						}
					>
						Remove from workspace
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			{locked ? (
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
		</>
	)
}

interface TriggerSnapshot {
	name?: unknown
	type?: unknown
	config?: unknown
	actionPrompt?: unknown
	targetActorId?: unknown
}

interface ActorSnapshot {
	name?: unknown
	type?: unknown
	systemPrompt?: unknown
}

/** The numbered flow, What it brings, and the ask-driven sections, all
 * derived from real trigger + actor snapshots — never per-loop copy. */
function LoopFlow({
	workspaceId,
	loop,
	items,
}: {
	workspaceId: string
	loop: MarketplaceLoopSummary
	items: MarketplaceLoopItem[]
}) {
	const triggers = items.filter((item) => item.item_type === 'trigger')
	const actorsBySourceId = new Map(
		items.filter((item) => item.item_type === 'actor').map((item) => [item.source_item_id, item]),
	)

	const steps = triggers.map((trigger, i) => {
		const snapshot = trigger.item_snapshot as TriggerSnapshot
		const targetActorId = typeof snapshot.targetActorId === 'string' ? snapshot.targetActorId : ''
		const agentItem = actorsBySourceId.get(targetActorId) as MarketplaceLoopItem | undefined
		const agentSnapshot = agentItem?.item_snapshot as ActorSnapshot | undefined
		const agentName =
			typeof agentSnapshot?.name === 'string' && agentSnapshot.name.trim()
				? agentSnapshot.name
				: 'An agent'
		const agentType = typeof agentSnapshot?.type === 'string' ? agentSnapshot.type : 'agent'
		const systemPrompt =
			typeof agentSnapshot?.systemPrompt === 'string' ? agentSnapshot.systemPrompt : ''
		const type = typeof snapshot.type === 'string' ? snapshot.type : ''
		const config = (snapshot.config ?? null) as Record<string, unknown> | null
		const actionPrompt = typeof snapshot.actionPrompt === 'string' ? snapshot.actionPrompt : ''

		return {
			num: i + 1,
			agentName,
			agentType,
			agentId: agentItem?.id ?? targetActorId,
			when: type ? describeTrigger({ type, config }) : '',
			what: actionPrompt,
			ask: stepAsksYou(systemPrompt),
		}
	})

	const askRows = steps.flatMap((step) => {
		if (!step.ask) return []
		return [
			{
				id: String(step.num),
				agentName: step.agentName,
				when: step.when,
				ask: step.ask.ask,
				why: step.ask.reason,
			},
		]
	})

	return (
		<>
			<FlowSection steps={steps} />
			{items.length > 0 && (
				<div>
					<div className="mb-3 flex items-center gap-2">
						<h2 className="text-sm font-semibold text-foreground">What it brings</h2>
						<span className="text-xs text-muted-foreground">everything installed in one go</span>
					</div>
					<div className="flex flex-col gap-2">
						{items.map((item) => (
							<LoopBringsRow key={item.id} workspaceId={workspaceId} loopId={loop.id} item={item} />
						))}
					</div>
				</div>
			)}
			<AsksSection rows={askRows} />
			<RunsSection rows={runsRows(loop, items)} />
			<PermissionsSection rows={permissionsRows(items)} />
		</>
	)
}

function runsRows(
	loop: MarketplaceLoopSummary,
	items: MarketplaceLoopItem[],
): { label: string; value: string }[] {
	const agents = items.filter((item) => item.item_type === 'actor')
	const providers = new Set<string>()
	const models = new Set<string>()
	for (const agent of agents) {
		const snapshot = agent.item_snapshot as Record<string, unknown>
		const provider = typeof snapshot.llmProvider === 'string' ? snapshot.llmProvider.trim() : ''
		if (provider) providers.add(provider)
		const config = (snapshot.llmConfig ?? {}) as Record<string, unknown>
		const model = typeof config.model === 'string' ? config.model.trim() : ''
		if (model) models.add(model)
	}

	const rows: { label: string; value: string }[] = [{ label: 'Version', value: loop.version }]
	if (providers.size > 0)
		rows.push({ label: 'Runtime', value: [...providers].map(capitalize).join(', ') })
	if (models.size > 0) rows.push({ label: 'Model', value: [...models].join(', ') })
	rows.push({
		label: 'Triggers',
		value: `${items.filter((item) => item.item_type === 'trigger').length} step${
			items.filter((item) => item.item_type === 'trigger').length === 1 ? '' : 's'
		}`,
	})
	return rows
}

function permissionsRows(items: MarketplaceLoopItem[]): { label: string; value: string }[] {
	const rows: { label: string; value: string }[] = [
		{ label: 'Scope', value: 'This workspace only' },
	]
	const tools = new Set<string>()
	for (const agent of items.filter((item) => item.item_type === 'actor')) {
		const snapshot = agent.item_snapshot as Record<string, unknown>
		const toolConfig = snapshot.tools
		if (toolConfig && typeof toolConfig === 'object' && !Array.isArray(toolConfig)) {
			const obj = toolConfig as Record<string, unknown>
			if (obj.mcpServers && typeof obj.mcpServers === 'object') {
				for (const key of Object.keys(obj.mcpServers as Record<string, unknown>)) tools.add(key)
			}
		}
	}
	if (tools.size > 0) rows.push({ label: 'Integrations', value: [...tools].join(', ') })
	return rows
}

function capitalize(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

interface LoopItemSnapshot {
	name?: unknown
	description?: unknown
}

function LoopBringsRow({
	workspaceId,
	loopId,
	item,
}: {
	workspaceId: string
	loopId: string
	item: MarketplaceLoopItem
}) {
	const snapshot = item.item_snapshot as LoopItemSnapshot
	const name =
		typeof snapshot.name === 'string' && snapshot.name.trim() ? snapshot.name : 'Untitled'
	const description = typeof snapshot.description === 'string' ? snapshot.description : null

	return (
		<Link
			to="/$workspaceId/marketplace/$loopId/$itemId"
			params={{ workspaceId, loopId, itemId: item.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 hover:bg-muted/40"
		>
			<span className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				{ITEM_TYPE_LABEL[item.item_type]}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium text-foreground">{name}</span>
				{description && (
					<span className="mt-0.5 block truncate text-xs text-muted-foreground">{description}</span>
				)}
			</span>
		</Link>
	)
}
