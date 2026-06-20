import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { cn } from '@/lib/cn'
import { Check, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'

interface ParticipantBarProps {
	participants: ConversationParticipant[]
	allAgents: ConversationParticipant[]
	workingAgentIds: string[]
	onAdd: (id: string) => void
	onRemove: (id: string) => void
	className?: string
}

/**
 * Roster of agents present in the conversation, rendered as compact removable
 * chips with a live "working…" pulse while an agent is mid-reply. The `+`
 * opens a picker of the remaining workspace agents. The default agent (Sindre)
 * is always present and cannot be removed.
 */
export function ParticipantBar({
	participants,
	allAgents,
	workingAgentIds,
	onAdd,
	onRemove,
	className,
}: ParticipantBarProps) {
	const working = useMemo(() => new Set(workingAgentIds), [workingAgentIds])

	return (
		<div className={cn('flex flex-wrap items-center gap-1', className)}>
			{participants.map((p) => {
				const isWorking = working.has(p.id)
				return (
					<span
						key={p.id}
						className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-surface py-0.5 pr-1 pl-1.5 text-xs text-foreground"
					>
						<span className="relative inline-flex">
							<ActorAvatar name={p.name} type="agent" size="sm" />
							{isWorking ? (
								<span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 animate-pulse rounded-full bg-primary ring-2 ring-bg-surface" />
							) : null}
						</span>
						<span className="max-w-[8rem] truncate">{p.name}</span>
						{p.isDefault ? null : (
							<button
								type="button"
								onClick={() => onRemove(p.id)}
								aria-label={`Remove ${p.name}`}
								className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							>
								<X size={10} aria-hidden />
							</button>
						)}
					</span>
				)
			})}
			<AddParticipant participants={participants} allAgents={allAgents} onAdd={onAdd} />
		</div>
	)
}

function AddParticipant({
	participants,
	allAgents,
	onAdd,
}: {
	participants: ConversationParticipant[]
	allAgents: ConversationParticipant[]
	onAdd: (id: string) => void
}) {
	const [open, setOpen] = useState(false)
	const presentIds = useMemo(() => new Set(participants.map((p) => p.id)), [participants])
	const available = useMemo(
		() => allAgents.filter((a) => !presentIds.has(a.id)),
		[allAgents, presentIds],
	)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-6 w-6 rounded-full border border-border border-dashed text-text-secondary"
							aria-label="Add agent to conversation"
						>
							<Plus size={13} />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>Add agent</TooltipContent>
			</Tooltip>
			<PopoverContent align="start" className="w-56 p-1">
				{available.length === 0 ? (
					<p className="px-2 py-3 text-center text-sm text-text-muted">All agents added.</p>
				) : (
					<ul className="max-h-64 overflow-y-auto">
						{available.map((agent) => (
							<li key={agent.id}>
								<button
									type="button"
									onClick={() => {
										onAdd(agent.id)
										setOpen(false)
									}}
									className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground text-sm hover:bg-bg-hover"
								>
									<ActorAvatar name={agent.name} type="agent" size="sm" />
									<span className="min-w-0 flex-1 truncate">{agent.name}</span>
									<Check size={14} className="text-text-muted opacity-0" aria-hidden />
								</button>
							</li>
						))}
					</ul>
				)}
			</PopoverContent>
		</Popover>
	)
}
