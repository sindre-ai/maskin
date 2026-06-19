import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { cn } from '@/lib/cn'

interface MentionTypeaheadProps {
	agents: ConversationParticipant[]
	activeIndex: number
	onSelect: (agent: ConversationParticipant) => void
	onHover: (index: number) => void
}

/**
 * Inline `@`-mention autocomplete surfaced above the composer. Purely
 * presentational: the composer owns the open state, the filtered `agents`
 * list, and keyboard navigation (`activeIndex`), so arrow keys keep working
 * while focus stays in the textarea.
 */
export function MentionTypeahead({
	agents,
	activeIndex,
	onSelect,
	onHover,
}: MentionTypeaheadProps) {
	if (agents.length === 0) return null
	return (
		<div
			className="absolute right-2 bottom-full left-2 z-30 mb-1 overflow-hidden rounded-md border border-border bg-popover shadow-md"
			aria-label="Mention an agent"
		>
			<ul className="max-h-56 overflow-y-auto p-1">
				{agents.map((agent, index) => (
					<li key={agent.id}>
						<button
							type="button"
							aria-pressed={index === activeIndex}
							// Use pointer-down so the click lands before the textarea blurs.
							onMouseDown={(e) => {
								e.preventDefault()
								onSelect(agent)
							}}
							onMouseEnter={() => onHover(index)}
							className={cn(
								'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
								index === activeIndex
									? 'bg-accent text-accent-foreground'
									: 'text-foreground hover:bg-bg-hover',
							)}
						>
							<ActorAvatar name={agent.name} type="agent" size="sm" />
							<span className="min-w-0 flex-1 truncate">{agent.name}</span>
							{agent.isDefault ? (
								<span className="shrink-0 text-text-muted text-xs">default</span>
							) : null}
						</button>
					</li>
				))}
			</ul>
		</div>
	)
}
