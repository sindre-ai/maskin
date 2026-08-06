import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ActorListItem, TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useState } from 'react'

interface LoopStepsProps {
	triggers: TriggerResponse[]
	actors: ActorListItem[] | undefined
	triggerCount: number
	agentCount: number
}

export function LoopSteps({ triggers, actors, triggerCount, agentCount }: LoopStepsProps) {
	const [agentFilter, setAgentFilter] = useState<string | null>(null)

	const actorsById = new Map((actors ?? []).map((a) => [a.id, a]))
	const distinctAgentIds = Array.from(new Set(triggers.map((t) => t.targetActorId)))
	const filteredTriggers = agentFilter
		? triggers.filter((t) => t.targetActorId === agentFilter)
		: triggers

	return (
		<div>
			<div className="flex items-center gap-2.5 mb-2.5">
				<h2 className="text-sm font-semibold text-foreground">The loop, right now</h2>
				<span className="text-xs text-muted-foreground">
					{triggerCount} {triggerCount === 1 ? 'trigger' : 'triggers'} · {agentCount}{' '}
					{agentCount === 1 ? 'agent' : 'agents'}
				</span>
			</div>

			{distinctAgentIds.length > 1 && (
				<div className="flex flex-wrap items-center gap-1.5 mb-3">
					<button
						type="button"
						onClick={() => setAgentFilter(null)}
						className={cn(
							'inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full text-[11.5px] font-medium border transition-colors',
							agentFilter === null
								? 'bg-foreground text-background border-foreground'
								: 'bg-transparent text-muted-foreground border-border hover:border-foreground/40',
						)}
					>
						All steps
						<span className="text-[10.5px] opacity-60">{triggers.length}</span>
					</button>
					{distinctAgentIds.map((agentId) => {
						const agent = actorsById.get(agentId)
						const count = triggers.filter((t) => t.targetActorId === agentId).length
						return (
							<button
								key={agentId}
								type="button"
								onClick={() => setAgentFilter(agentFilter === agentId ? null : agentId)}
								className={cn(
									'inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full text-[11.5px] font-medium border transition-colors',
									agentFilter === agentId
										? 'bg-foreground text-background border-foreground'
										: 'bg-transparent text-muted-foreground border-border hover:border-foreground/40',
								)}
							>
								{agent?.name ?? 'Unknown agent'}
								<span className="text-[10.5px] opacity-60">{count}</span>
							</button>
						)
					})}
				</div>
			)}

			<div className="border border-border rounded-xl bg-card p-3">
				{filteredTriggers.length === 0 ? (
					<p className="text-xs text-muted-foreground py-2">No step matches that filter.</p>
				) : (
					<div className="flex flex-col gap-3">
						{filteredTriggers.map((trigger) => {
							const agent = actorsById.get(trigger.targetActorId)
							return (
								<div key={trigger.id} className="flex items-start gap-2.5">
									<ActorAvatar
										id={trigger.targetActorId}
										name={agent?.name ?? 'Unknown agent'}
										type={agent?.type ?? 'agent'}
										className="mt-0.5"
									/>
									<div className="flex-1 min-w-0 text-[12.5px] leading-relaxed">
										<span className="font-semibold text-foreground">
											{agent?.name ?? 'Unknown agent'}
										</span>{' '}
										<span className="text-muted-foreground">{trigger.actionPrompt}</span>
									</div>
									{!trigger.enabled && (
										<span className="text-[10.5px] font-medium text-muted-foreground shrink-0 mt-0.5">
											off
										</span>
									)}
								</div>
							)
						})}
					</div>
				)}
			</div>
		</div>
	)
}
