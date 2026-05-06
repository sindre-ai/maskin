import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActors } from '@/hooks/use-actors'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'

interface AssigneeStackProps {
	/** Ordered list of actor IDs. Order is preserved (callers decide ordering — typically latest activity first). */
	actorIds: string[]
	/** Subset of `actorIds` whose owning agent currently has a `running` session. Pulsing dot is the only per-card animation. */
	runningAgentIds?: ReadonlySet<string>
	/** Maximum avatars rendered before collapsing to a `+N` overflow chip. Defaults to 3 per spec. */
	max?: number
	/** Click handler — when provided, each avatar becomes a button (used by Task 5 to filter the board). */
	onAssigneeClick?: (actorId: string) => void
}

/**
 * Equal-weighted avatar stack for humans and agents. The brief's load-bearing
 * detail: same size, same hover treatment, same click behavior — no
 * "delegate" sub-treatment. A pulsing dot marks agents whose session is
 * actively running. Unknown actor IDs render as a neutral fallback rather
 * than disappear silently.
 */
export function AssigneeStack({
	actorIds,
	runningAgentIds,
	max = 3,
	onAssigneeClick,
}: AssigneeStackProps) {
	const { workspaceId } = useWorkspace()
	const { data: actors } = useActors(workspaceId)

	if (actorIds.length === 0) return null

	const actorById = new Map<string, ActorListItem>()
	for (const a of actors ?? []) actorById.set(a.id, a)

	const visibleIds = actorIds.slice(0, max)
	const overflow = actorIds.length - visibleIds.length

	return (
		<div className="flex items-center -space-x-1.5">
			{visibleIds.map((id) => {
				const actor = actorById.get(id)
				const name = actor?.name ?? 'Unknown'
				const type = actor?.type ?? 'human'
				const showPulse = type === 'agent' && runningAgentIds?.has(id) === true
				return (
					<AvatarChip
						key={id}
						name={name}
						type={type}
						showPulse={showPulse}
						onClick={onAssigneeClick ? () => onAssigneeClick(id) : undefined}
					/>
				)
			})}
			{overflow > 0 && (
				<span
					className={cn(
						'relative inline-flex h-5 min-w-5 items-center justify-center rounded-full',
						'border border-background bg-muted px-1 text-[10px] font-medium text-muted-foreground',
					)}
					title={`${overflow} more`}
					aria-label={`${overflow} more assignees`}
				>
					+{overflow}
				</span>
			)}
		</div>
	)
}

interface AvatarChipProps {
	name: string
	type: string
	showPulse: boolean
	onClick?: () => void
}

function AvatarChip({ name, type, showPulse, onClick }: AvatarChipProps) {
	const ringClass = 'ring-2 ring-background'
	const inner = (
		<>
			<ActorAvatar name={name} type={type} size="sm" className={ringClass} />
			{showPulse && (
				<span
					className="absolute -right-0.5 -top-0.5 inline-flex h-2 w-2 items-center justify-center"
					aria-label={`${name} is working`}
					data-testid="assignee-pulse-dot"
				>
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
					<span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
				</span>
			)}
		</>
	)
	if (onClick) {
		return (
			<button
				type="button"
				className="relative inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onClick={(e) => {
					// Avatars sit inside a clickable card — stop the parent click from
					// also navigating to the detail page.
					e.stopPropagation()
					onClick()
				}}
				aria-label={`Filter board to ${name}`}
			>
				{inner}
			</button>
		)
	}
	return <span className="relative inline-flex shrink-0">{inner}</span>
}
