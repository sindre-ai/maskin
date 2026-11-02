import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { CreatePicker } from '@/components/shared/create-picker'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { describeTrigger } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useCanWrite } from '@/hooks/use-can-write'
import { useTriggers, useUpdateTrigger } from '@/hooks/use-triggers'
import type { ActorResponse, TriggerResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { Bell, ChevronRight, Clock, Plus, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

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
	const [createOpen, setCreateOpen] = useState(false)
	const canWrite = useCanWrite()

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
					<div className="flex items-center gap-1">
						{isTruncated && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 shrink-0 px-2 text-xs font-medium"
								aria-expanded={showAll}
								onClick={() => setShowAll((v) => !v)}
							>
								{showAll ? 'Show fewer' : `Show all ${agentTriggers.length}`}
							</Button>
						)}
						<ViewerTooltip>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 shrink-0 px-2 text-xs font-medium"
								disabled={!canWrite}
								onClick={() => setCreateOpen(true)}
							>
								<Plus size={14} aria-hidden />
								New trigger
							</Button>
						</ViewerTooltip>
					</div>
				}
			/>

			{isLoading ? (
				<div className="flex items-center justify-center py-6">
					<Spinner />
				</div>
			) : agentTriggers.length === 0 ? (
				<p className="py-4 text-center text-sm text-muted-foreground">
					Nothing wakes this agent yet. Add a schedule or an event.
				</p>
			) : (
				<ul className="flex flex-col border-t border-border">
					{shownTriggers.map((trigger) => (
						<li key={trigger.id}>
							<TriggerCard trigger={trigger} workspaceId={workspaceId} />
						</li>
					))}
				</ul>
			)}
			{/* The picker has no way to preselect the agent yet, so the new trigger
			    is pointed at this agent on its own page. */}
			<CreatePicker open={createOpen} onOpenChange={setCreateOpen} defaultType="trigger" />
		</section>
	)
}

function TriggerCard({ trigger, workspaceId }: { trigger: TriggerResponse; workspaceId: string }) {
	const canWrite = useCanWrite()
	const updateTrigger = useUpdateTrigger(workspaceId)
	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap

	return (
		<div className="flex items-center gap-2.5 border-b border-border py-2.5">
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
			<ViewerTooltip>
				<Switch
					checked={trigger.enabled}
					disabled={!canWrite || updateTrigger.isPending}
					aria-label={`${trigger.enabled ? 'Turn off' : 'Turn on'} ${trigger.name}`}
					onCheckedChange={(enabled) =>
						updateTrigger.mutate(
							{ id: trigger.id, data: { enabled } },
							{ onError: () => toast.error(`Couldn't update ${trigger.name}`) },
						)
					}
				/>
			</ViewerTooltip>
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
