import { MarketplaceBreadcrumb } from '@/components/marketplace/marketplace-breadcrumb'
import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
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
import type { InstalledLoopRow, MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { stepAsksYou } from '@/lib/marketplace-asks'
import { Link } from '@tanstack/react-router'
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { ForkDialog } from './fork-dialog'
import { InstallButton } from './install-button'
import { ITEM_TYPE_LABEL, loopKind } from './item-type-label'
import { MarketplaceDetailHeader } from './marketplace-detail-header'
import { AsksSection, FlowSection, PermissionsSection, RunsSection } from './marketplace-disclosure'
import { UninstallDialog } from './uninstall-dialog'

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
	const kind = loopKind(loop.item_types)

	return (
		// The action bar sits outside the scroll region so the breadcrumb,
		// Install/Manage and the ⋯ menu stay reachable without scrolling at 375px
		// (mockup 2610–2628).
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border pb-3">
				<MarketplaceBreadcrumb workspaceId={workspaceId} items={[{ label: loop.name }]} />
				<div className="ml-auto flex shrink-0 items-center gap-2">
					<HeaderActions workspaceId={workspaceId} loop={loop} install={install} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-7 py-6">
					<MarketplaceDetailHeader
						kind={kind}
						name={loop.name}
						description={loop.description}
						badge={
							install ? (
								<div className="flex shrink-0 flex-wrap items-center gap-2">
									<Badge className="gap-1.5 whitespace-nowrap border-transparent bg-status-active-bg text-[12px] font-semibold text-status-active-text">
										<Check aria-hidden="true" className="size-3.5" />
										Installed
									</Badge>
									{locked ? (
										<Badge
											variant="secondary"
											className="whitespace-nowrap text-[11px] font-medium"
										>
											🔒 Managed · v{install.installedVersion}
										</Badge>
									) : (
										<Badge
											variant="outline"
											className="whitespace-nowrap text-[11px] font-medium text-foreground"
										>
											⑂ Forked from v{install.installedVersion}
										</Badge>
									)}
								</div>
							) : undefined
						}
					/>

					<LoopFlow workspaceId={workspaceId} loop={loop} items={items} />
				</div>
			</div>
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
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false

	// Not installed — the primary Install is the only action.
	if (!install) {
		return <InstallButton workspaceId={workspaceId} loopId={loop.id} source="detail" />
	}

	// Installed loops with a provisioned object get a Manage link to it (mockup
	// 2613). Older installs have nothing for Manage to point at, so Remove takes
	// the primary slot instead — the same fallback the catalogue card uses — and
	// drops out of the ⋯ menu so the destructive action never renders twice.
	const canManage = Boolean(install.objectId)

	return (
		<>
			{install.objectId ? (
				<Button asChild size="sm" variant="outline">
					<Link to="/$workspaceId/loops/$loopId" params={{ workspaceId, loopId: install.objectId }}>
						Manage
					</Link>
				</Button>
			) : (
				<Button size="sm" variant="outline" onClick={() => setUninstallOpen(true)}>
					Remove
				</Button>
			)}

			{locked || canManage ? (
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
								<DropdownMenuItem onSelect={() => setForkOpen(true)}>
									Fork this loop
								</DropdownMenuItem>
								{canManage ? <DropdownMenuSeparator /> : null}
							</>
						) : null}
						{canManage ? (
							<DropdownMenuItem
								className="text-error focus:text-error"
								onSelect={() => setUninstallOpen(true)}
							>
								Remove from workspace
							</DropdownMenuItem>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}

			{/* Removing discards provisioned agents, triggers and skills, so it
			    always routes through the same confirmation the catalogue card
			    uses — never a bare menu-select mutation. */}
			<UninstallDialog
				open={uninstallOpen}
				onOpenChange={setUninstallOpen}
				workspaceId={workspaceId}
				installedLoopId={install.id}
				loopName={loop.name}
				isLocked={locked}
			/>

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
	const isBundle = loop.item_types.length > 1

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
			<FlowSection
				steps={steps}
				title={isBundle ? 'The loop, once installed' : 'How it works'}
				subtitle={
					isBundle
						? 'the steps that move work between states'
						: 'when it acts, and where it stops for you'
				}
			/>
			{items.length > 0 && (
				<div>
					<div className="mb-3 flex items-center gap-2.5">
						<h2 className="shrink-0 text-sm font-bold text-foreground">What it brings</h2>
						<span className="min-w-0 truncate text-xs text-muted-foreground">
							everything installed in one go
						</span>
						<span aria-hidden="true" className="h-px flex-1 bg-border" />
					</div>
					<div className="flex flex-col gap-2">
						{items.map((item) => (
							<LoopBringsRow key={item.id} workspaceId={workspaceId} loopId={loop.id} item={item} />
						))}
					</div>
				</div>
			)}
			<AsksSection rows={askRows} note="Everything else runs without you." />
			<RunsSection rows={runsRows(loop, items)} />
			<PermissionsSection pills={permissionPills(items)} />
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

/** One pill per real permission (mockup 2708–2711): the product-level scope
 * every install is bound to, then each MCP surface the loop's agents declare. */
function permissionPills(items: MarketplaceLoopItem[]): string[] {
	const pills = ['This workspace only']
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
	return [...pills, ...tools]
}

function capitalize(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

interface LoopItemSnapshot {
	name?: unknown
	description?: unknown
}

/** "What it brings" row (mockup 2680–2684): 28px glyph tile, label over a
 * kind-led sub-line, trailing caret. */
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
	const sub = description
		? `${ITEM_TYPE_LABEL[item.item_type]} · ${description}`
		: ITEM_TYPE_LABEL[item.item_type]

	return (
		<Link
			to="/$workspaceId/marketplace/$loopId/$itemId"
			params={{ workspaceId, loopId, itemId: item.id }}
			className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong hover:shadow-md"
		>
			<span
				aria-hidden="true"
				className={cn(
					'grid size-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold',
					item.item_type === 'actor'
						? getActorAvatarPaletteClass(name)
						: 'bg-muted text-muted-foreground',
				)}
			>
				{getActorInitials(name)}
			</span>
			<span className="min-w-0 flex-1 leading-tight">
				<span className="block truncate text-[12.5px] font-semibold text-foreground">{name}</span>
				<span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{sub}</span>
			</span>
			<ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
		</Link>
	)
}
