import { ActorAvatar } from '@/components/shared/actor-avatar'
import { PeoplePicker } from '@/components/sindre/people-picker'
import { Button } from '@/components/ui/button'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { cn } from '@/lib/cn'
import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'

interface ParticipantBarProps {
	participants: ConversationParticipant[]
	allActors: ConversationParticipant[]
	workingAgentIds: string[]
	onAdd: (id: string) => void
	onRemove: (id: string) => void
	className?: string
}

// T5 design caps the bar at 3 chips on ≤639px, with `+N more` opening the
// hidden roster. Driven via Tailwind `max-sm:` / `sm:` rather than the
// 768px `useIsMobile()` hook so there's no SSR/hydration flicker and the
// breakpoint matches the design spec literally.
const MOBILE_CHIP_CAP = 3

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
	const [overflowOpen, setOverflowOpen] = useState(false)

	const overflowCount = Math.max(0, participants.length - MOBILE_CHIP_CAP)
	const overflowParticipants = participants.slice(MOBILE_CHIP_CAP)

	return (
		<div className={cn('flex flex-wrap items-center gap-1', className)}>
			{participants.map((p, idx) => {
				const isWorking = p.kind === 'agent' && working.has(p.id)
				const overflow = idx >= MOBILE_CHIP_CAP
				return (
					<span
						key={p.id}
						data-overflow={overflow ? 'true' : undefined}
						className={cn(
							'inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-surface py-0.5 pr-1 pl-1.5 text-foreground text-xs',
							overflow && 'max-sm:hidden',
						)}
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
			{overflowCount > 0 ? (
				<ResponsivePopover open={overflowOpen} onOpenChange={setOverflowOpen}>
					<ResponsivePopoverTrigger asChild>
						<button
							type="button"
							aria-label={`Show ${overflowCount} more participant${overflowCount === 1 ? '' : 's'}`}
							className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-surface px-2 py-0.5 text-foreground text-xs hover:bg-bg-hover sm:hidden"
						>
							+{overflowCount} more
						</button>
					</ResponsivePopoverTrigger>
					<ResponsivePopoverContent
						align="start"
						className="flex w-64 flex-col gap-1 p-2"
						accessibleTitle="More participants"
					>
						<ul className="flex flex-col gap-1">
							{overflowParticipants.map((p) => {
								const isWorking = p.kind === 'agent' && working.has(p.id)
								return (
									<li key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
										<span className="relative inline-flex">
											<ActorAvatar name={p.name} type={p.kind} size="sm" />
											{isWorking ? (
												<span className="-right-0.5 -bottom-0.5 absolute h-2 w-2 animate-pulse rounded-full bg-primary ring-2 ring-bg-surface" />
											) : null}
										</span>
										<span className="flex-1 truncate text-foreground text-sm">{p.name}</span>
										{p.isDefault ? null : (
											<button
												type="button"
												onClick={() => {
													onRemove(p.id)
													if (overflowParticipants.length === 1) setOverflowOpen(false)
												}}
												aria-label={`Remove ${p.name}`}
												className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
											>
												<X size={14} aria-hidden />
											</button>
										)}
									</li>
								)
							})}
						</ul>
					</ResponsivePopoverContent>
				</ResponsivePopover>
			) : null}
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
