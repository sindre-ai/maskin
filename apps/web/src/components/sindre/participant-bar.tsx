import { ActorAvatar } from '@/components/shared/actor-avatar'
import { PeoplePicker } from '@/components/sindre/people-picker'
import { Button } from '@/components/ui/button'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { cn } from '@/lib/cn'
import { Plus, X } from 'lucide-react'
import { useMemo } from 'react'

interface ParticipantBarProps {
	participants: ConversationParticipant[]
	allActors: ConversationParticipant[]
	workingAgentIds: string[]
	onAdd: (id: string) => void
	onRemove: (id: string) => void
	className?: string
}

/**
 * Roster of humans and agents present in the conversation, rendered as compact
 * removable chips with a live "working…" pulse while an agent is mid-reply.
 * The `+` opens a tabbed People & Agents picker covering everyone in the
 * workspace. The default agent (Sindre) is always present and cannot be
 * removed.
 */
export function ParticipantBar({
	participants,
	allActors,
	workingAgentIds,
	onAdd,
	onRemove,
	className,
}: ParticipantBarProps) {
	const working = useMemo(() => new Set(workingAgentIds), [workingAgentIds])

	return (
		<div className={cn('flex flex-wrap items-center gap-1', className)}>
			{participants.map((p) => {
				const isWorking = p.kind === 'agent' && working.has(p.id)
				return (
					<span
						key={p.id}
						className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-surface py-0.5 pr-1 pl-1.5 text-foreground text-xs"
					>
						<span className="relative inline-flex">
							<ActorAvatar name={p.name} type={p.kind} size="sm" />
							{isWorking ? (
								<span className="-right-0.5 -bottom-0.5 absolute h-2 w-2 animate-pulse rounded-full bg-primary ring-2 ring-bg-surface" />
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
			<PeoplePicker
				participants={participants}
				allActors={allActors}
				onAdd={onAdd}
				defaultTab="all"
				align="start"
				trigger={
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6 rounded-full border border-border border-dashed text-text-secondary"
						aria-label="Add people or agents"
						title="Add people or agents"
					>
						<Plus size={13} />
					</Button>
				}
			/>
		</div>
	)
}
