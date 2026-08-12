import { ActorAvatar } from '@/components/shared/actor-avatar'
import { describeTrigger } from '@/components/triggers/trigger-row'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { InstalledLoopRow, MarketplaceLoopItem, MarketplaceLoopSummary } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ITEM_TYPE_LABEL } from './item-type-label'
import { LoopInstallControls } from './loop-install-controls'
import { MarketplaceDetailHeader } from './marketplace-detail-header'

// A loop can carry dozens of triggers with multi-paragraph action prompts —
// show a short preview by default so the page doesn't open into a wall of text.
const HOW_IT_WORKS_PREVIEW_COUNT = 5

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
		<div className="space-y-6">
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
				actions={
					<LoopInstallControls
						workspaceId={workspaceId}
						loop={loop}
						install={install}
						source="detail"
					/>
				}
			/>

			<LoopHowItWorks items={items} />

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
		</div>
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
}

/** Real, derived from each trigger item's own snapshot — not per-loop copy.
 * `targetActorId` is validated at publish time to match an actor item's
 * `source_item_id` in the same loop (see dev-bootstrap.ts), so every trigger
 * resolves to a real agent from the bundle. */
function LoopHowItWorks({ items }: { items: MarketplaceLoopItem[] }) {
	const [expanded, setExpanded] = useState(false)
	const triggers = items.filter((item) => item.item_type === 'trigger')
	if (triggers.length === 0) return null

	const actorsBySourceId = new Map(
		items.filter((item) => item.item_type === 'actor').map((item) => [item.source_item_id, item]),
	)
	const shown = expanded ? triggers : triggers.slice(0, HOW_IT_WORKS_PREVIEW_COUNT)
	const remaining = triggers.length - shown.length

	return (
		<div>
			<div className="mb-3 flex items-center gap-2">
				<h2 className="text-sm font-semibold text-foreground">How it works</h2>
				<span className="text-xs text-muted-foreground">when it acts, and what it does</span>
			</div>
			<div className="flex flex-col gap-2">
				{shown.map((trigger) => (
					<TriggerFlowRow key={trigger.id} trigger={trigger} actorsBySourceId={actorsBySourceId} />
				))}
			</div>
			{remaining > 0 && (
				<Button
					variant="ghost"
					size="sm"
					className="mt-2 text-muted-foreground"
					onClick={() => setExpanded(true)}
				>
					Show {remaining} more {remaining === 1 ? 'step' : 'steps'}
				</Button>
			)}
		</div>
	)
}

function TriggerFlowRow({
	trigger,
	actorsBySourceId,
}: {
	trigger: MarketplaceLoopItem
	actorsBySourceId: Map<string, MarketplaceLoopItem>
}) {
	const snapshot = trigger.item_snapshot as TriggerSnapshot
	const type = typeof snapshot.type === 'string' ? snapshot.type : ''
	const config = (snapshot.config ?? null) as Record<string, unknown> | null
	const actionPrompt = typeof snapshot.actionPrompt === 'string' ? snapshot.actionPrompt : ''
	const targetActorId = typeof snapshot.targetActorId === 'string' ? snapshot.targetActorId : ''

	const agentItem = actorsBySourceId.get(targetActorId)
	const agentSnapshot = agentItem?.item_snapshot as ActorSnapshot | undefined
	const agentName =
		typeof agentSnapshot?.name === 'string' && agentSnapshot.name.trim()
			? agentSnapshot.name
			: 'An agent'
	const agentType = typeof agentSnapshot?.type === 'string' ? agentSnapshot.type : 'agent'

	const when = type ? describeTrigger({ type, config }) : ''

	return (
		<div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
			<ActorAvatar
				id={targetActorId || agentName}
				name={agentName}
				type={agentType}
				className="mt-0.5"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className="text-sm font-medium text-foreground">{agentName}</span>
					{when && <span className="text-xs text-muted-foreground">{when}</span>}
				</div>
				{actionPrompt && (
					<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{actionPrompt}</p>
				)}
			</div>
		</div>
	)
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
	const snapshot = item.item_snapshot as { name?: unknown; description?: unknown }
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
