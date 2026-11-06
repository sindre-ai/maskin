import { ActorAvatar } from '@/components/shared/actor-avatar'
import { describeTrigger } from '@/components/triggers/trigger-row'
import { Switch } from '@/components/ui/switch'
import { useCanWrite } from '@/hooks/use-can-write'
import { useUpdateTrigger } from '@/hooks/use-triggers'
import type { ActorListItem, LoopSummary, TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

function chipClasses(active: boolean) {
	return cn(
		'inline-flex h-[30px] max-w-full items-center gap-[7px] rounded-full border px-[13px] text-[12.5px] font-semibold transition-colors',
		active
			? 'border-primary bg-primary text-primary-foreground'
			: 'border-border bg-background text-foreground hover:border-border-strong',
	)
}

/** One agent's step in the pipeline: the agent and the triggers that set it off. */
interface PipelineStep {
	agentId: string
	agent: ActorListItem | undefined
	triggers: TriggerResponse[]
}

/**
 * Steps in the order the flow names its triggers (`LoopSummary.triggerIds` is
 * the ordered spine); an agent sits where its first trigger does. Without a
 * spine the steps fall back to A to Z by agent name.
 */
function buildSteps(
	triggers: TriggerResponse[],
	actorsById: Map<string, ActorListItem>,
	spine: readonly string[] | undefined,
	agentIds: readonly string[] = [],
): PipelineStep[] {
	const rank = (t: TriggerResponse) => {
		const at = spine?.indexOf(t.id) ?? -1
		return at === -1 ? Number.MAX_SAFE_INTEGER : at
	}
	const ordered = [...triggers].sort(
		(a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	)
	const byAgent = new Map<string, TriggerResponse[]>()
	for (const t of ordered)
		byAgent.set(t.targetActorId, [...(byAgent.get(t.targetActorId) ?? []), t])
	const steps = [...byAgent].map(([agentId, list]) => ({
		agentId,
		agent: actorsById.get(agentId),
		triggers: list,
	}))
	// An agent the flow names but no trigger sets off is still a step, with none.
	for (const agentId of agentIds) {
		if (!byAgent.has(agentId)) steps.push({ agentId, agent: actorsById.get(agentId), triggers: [] })
	}
	if (spine && spine.length > 0) return steps
	return steps.sort((a, b) =>
		(a.agent?.name ?? '').localeCompare(b.agent?.name ?? '', undefined, {
			sensitivity: 'base',
			numeric: true,
		}),
	)
}

function TriggerCard({
	workspaceId,
	trigger,
}: {
	workspaceId: string
	trigger: TriggerResponse
}) {
	const canWrite = useCanWrite()
	const update = useUpdateTrigger(workspaceId)
	const kind = trigger.type === 'cron' ? 'Schedule' : 'Event'
	// The card reads as what happens: the trigger's name, then the first line of what it asks the
	// agent to do. A trigger with neither says when it fires, so no card is ever blank.
	const when = describeTrigger(trigger)
	const instruction = trigger.actionPrompt?.trim().split('\n')[0]?.slice(0, 160) ?? ''
	const title = trigger.name?.trim() || instruction || when
	const detail = instruction && instruction !== title ? instruction : title !== when ? when : ''
	return (
		// The card opens the trigger's own page; the switch sits on top of it and acts
		// without opening it. With `/triggers` folded into flows, this card is the only
		// route into a flow-owned trigger's detail page.
		<div
			className={cn(
				'relative rounded-xl bg-muted transition-opacity',
				!trigger.enabled && 'opacity-55',
			)}
		>
			<Link
				to="/$workspaceId/triggers/$triggerId"
				params={{ workspaceId, triggerId: trigger.id }}
				className="flex flex-col gap-1 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-border/50"
			>
				<span className="pr-10 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
					{kind}
				</span>
				<span className="min-w-0 break-words text-[13px] leading-[1.35] text-foreground">
					{title}
				</span>
				{detail && (
					<span className="min-w-0 break-words text-[12px] leading-[1.35] text-muted-foreground">
						{detail}
					</span>
				)}
			</Link>
			<Switch
				checked={trigger.enabled}
				disabled={!canWrite || update.isPending}
				aria-label={`${trigger.enabled ? 'Pause' : 'Turn on'} ${title}`}
				onCheckedChange={(enabled) =>
					update.mutate(
						{ id: trigger.id, data: { enabled } },
						{ onError: () => toast.error('Could not update the trigger') },
					)
				}
				className="absolute right-3 top-2.5 data-[state=checked]:bg-brand"
			/>
		</div>
	)
}

export function LoopFlow({
	workspaceId,
	triggers,
	actors,
	loop,
	onAddTrigger,
	addingTrigger = false,
}: {
	workspaceId: string
	triggers: TriggerResponse[]
	actors: ActorListItem[] | undefined
	loop?: LoopSummary
	/** Adds a trigger to this flow. Omitted for viewers, so the control is not offered. */
	onAddTrigger?: () => void
	/** A trigger is being added; the control waits so a double click adds one. */
	addingTrigger?: boolean
}) {
	const [agentFilter, setAgentFilter] = useState<string | null>(null)
	const actorsById = new Map((actors ?? []).map((a) => [a.id, a]))
	const steps = buildSteps(triggers, actorsById, loop?.triggerIds, loop?.agentIds)
	const shown = agentFilter ? steps.filter((s) => s.agentId === agentFilter) : steps

	return (
		<section
			id="loop-flow"
			data-loop-flow-root
			aria-label="Pipeline"
			className="flex flex-col gap-3.5"
		>
			<div className="flex items-baseline gap-3 px-1">
				<h2 className="flex-1 text-[13px] font-semibold text-muted-foreground">Pipeline</h2>
				{onAddTrigger && (
					<button
						type="button"
						onClick={onAddTrigger}
						disabled={addingTrigger}
						className="text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
					>
						+ Add trigger
					</button>
				)}
			</div>

			{steps.length > 1 && triggers.length > 0 && (
				<div className="flex flex-wrap gap-1.5 px-1">
					<button
						type="button"
						onClick={() => setAgentFilter(null)}
						className={chipClasses(agentFilter === null)}
					>
						All steps
						<span className="opacity-55">{triggers.length}</span>
					</button>
					{steps.map((step) => (
						<button
							key={step.agentId}
							type="button"
							onClick={() => setAgentFilter(agentFilter === step.agentId ? null : step.agentId)}
							className={chipClasses(agentFilter === step.agentId)}
						>
							<span className="min-w-0 truncate">{step.agent?.name ?? 'Unknown agent'}</span>
							<span className="opacity-55">{step.triggers.length}</span>
						</button>
					))}
				</div>
			)}

			{shown.length > 0 && (
				<div
					data-testid="loop-pipeline"
					className="flex overflow-x-auto rounded-2xl border border-border bg-background shadow-xs"
				>
					{shown.map((step, index) => (
						<div
							key={step.agentId}
							className={cn(
								'flex min-w-48 shrink-0 flex-1 flex-col gap-3.5 px-4 pb-4 pt-[18px]',
								index > 0 && 'border-l border-border',
							)}
						>
							<Link
								to="/$workspaceId/agents/$agentId"
								params={{ workspaceId, agentId: step.agentId }}
								className="flex items-center gap-[9px] hover:underline"
							>
								<ActorAvatar
									id={step.agentId}
									name={step.agent?.name ?? 'Unknown agent'}
									type={step.agent?.type ?? 'agent'}
									size="md"
									className="shrink-0"
								/>
								<span className="min-w-0 break-words text-[13px] leading-[1.3] text-foreground">
									{step.agent?.name ?? 'Unknown agent'}
								</span>
							</Link>
							<div className="flex flex-col gap-2">
								{step.triggers.length === 0 ? (
									<span className="text-[12.5px] text-muted-foreground">No trigger</span>
								) : (
									step.triggers.map((t) => (
										<TriggerCard key={t.id} workspaceId={workspaceId} trigger={t} />
									))
								)}
							</div>
						</div>
					))}
				</div>
			)}

			{triggers.length === 0 && (
				<p className="px-1 text-sm text-muted-foreground">This flow runs when you ask.</p>
			)}
		</section>
	)
}
