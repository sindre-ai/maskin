import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { describeTrigger } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTriggers } from '@/hooks/use-triggers'
import type { ActorResponse, TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { Bell, ChevronRight, Clock, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

/** Triggers listed before the section collapses behind "Show all". */
const COLLAPSED_TRIGGERS = 3

const TRIGGER_TYPE_ICON: Record<string, typeof Zap> = {
	event: Zap,
	cron: Clock,
	reminder: Bell,
}

function sortTriggers(a: TriggerResponse, b: TriggerResponse): number {
	if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
	return a.name.localeCompare(b.name)
}

/**
 * Triggers that fire this agent (`targetActorId`). Same collapse behaviour as
 * the Sessions section, but each row links straight to the trigger detail page
 * instead of expanding in place.
 */
export function AgentTriggersSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const [showAll, setShowAll] = useState(false)

	const agentTriggers = useMemo(
		() => (triggers ?? []).filter((t) => t.targetActorId === agent.id).sort(sortTriggers),
		[triggers, agent.id],
	)

	const isTruncated = agentTriggers.length > COLLAPSED_TRIGGERS
	const shownTriggers =
		showAll || !isTruncated ? agentTriggers : agentTriggers.slice(0, COLLAPSED_TRIGGERS)

	return (
		<section aria-labelledby="agent-triggers-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-triggers-heading"
				title="Triggers"
				note={agentTriggers.length > 0 ? String(agentTriggers.length) : undefined}
				action={
					isTruncated ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 shrink-0 px-2 text-xs font-medium"
							aria-expanded={showAll}
							onClick={() => setShowAll((v) => !v)}
						>
							{showAll ? 'Show fewer' : `Show all ${agentTriggers.length}`}
						</Button>
					) : undefined
				}
			/>

			{isLoading ? (
				<div className="flex items-center justify-center py-6">
					<Spinner />
				</div>
			) : agentTriggers.length === 0 ? (
				<p className="py-4 text-center text-sm text-muted-foreground">
					No triggers fire this agent yet.
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{shownTriggers.map((trigger) => (
						<li key={trigger.id}>
							<TriggerCard trigger={trigger} workspaceId={workspaceId} />
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

function TriggerCard({ trigger, workspaceId }: { trigger: TriggerResponse; workspaceId: string }) {
	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap

	return (
		<div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2">
			<span
				aria-hidden
				className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
			>
				<Icon className="size-3.5" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm font-medium text-foreground">{trigger.name}</span>
				<span className="truncate text-[11px] text-muted-foreground">
					{describeTrigger(trigger)}
				</span>
			</div>
			<span
				className={cn(
					'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
					trigger.enabled
						? 'bg-status-completed-bg text-status-completed-text'
						: 'bg-muted text-muted-foreground',
				)}
			>
				{trigger.enabled ? 'On' : 'Off'}
			</span>
			<Link
				to="/$workspaceId/triggers/$triggerId"
				params={{ workspaceId, triggerId: trigger.id }}
				className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
				aria-label={`Open ${trigger.name}`}
			>
				Open
				<ChevronRight className="size-3" aria-hidden />
			</Link>
		</div>
	)
}
