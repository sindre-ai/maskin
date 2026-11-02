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
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

/** Triggers listed before the section collapses behind "Show all". */
const COLLAPSED_TRIGGERS = 3

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
		<section aria-labelledby="agent-triggers-heading" className="flex flex-col gap-3">
			{/* v16 opens the tab on the rows; the heading stays for screen readers. */}
			<AgentSectionHeading
				id="agent-triggers-heading"
				title="Triggers"
				note={agentTriggers.length > 0 ? String(agentTriggers.length) : undefined}
				srOnly
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
			<div className="flex items-center gap-2">
				<ViewerTooltip>
					<Button
						variant="outline"
						size="sm"
						className="h-8 rounded-full px-3.5 text-[13px] font-semibold"
						disabled={!canWrite}
						onClick={() => setCreateOpen(true)}
					>
						<Plus size={14} aria-hidden />
						New trigger
					</Button>
				</ViewerTooltip>
				{isTruncated && (
					<Button
						variant="ghost"
						size="sm"
						className="h-8 px-2 text-[13px] font-semibold text-muted-foreground"
						aria-expanded={showAll}
						onClick={() => setShowAll((v) => !v)}
					>
						{showAll ? 'Show fewer' : `Show all ${agentTriggers.length}`}
					</Button>
				)}
			</div>
			{/* The picker has no way to preselect the agent yet, so the new trigger
			    is pointed at this agent on its own page. */}
			<CreatePicker open={createOpen} onOpenChange={setCreateOpen} defaultType="trigger" />
		</section>
	)
}

function TriggerCard({ trigger, workspaceId }: { trigger: TriggerResponse; workspaceId: string }) {
	const canWrite = useCanWrite()
	const updateTrigger = useUpdateTrigger(workspaceId)

	return (
		<div className="flex items-center gap-3 border-b border-border px-1 py-3 leading-snug">
			<Link
				to="/$workspaceId/triggers/$triggerId"
				params={{ workspaceId, triggerId: trigger.id }}
				className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={`Open ${trigger.name}`}
			>
				<span className="truncate text-[15px] font-semibold text-foreground">{trigger.name}</span>
				<span className="truncate text-[13px] text-muted-foreground">
					{describeTrigger(trigger)}
				</span>
			</Link>
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
		</div>
	)
}
