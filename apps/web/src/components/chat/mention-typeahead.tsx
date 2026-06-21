import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useMemo } from 'react'

export interface MentionableActor {
	id: string
	name: string
	type: string
}

export interface MentionTypeaheadProps {
	actors: ActorListItem[]
	filter: string
	excludeActorIds?: string[]
	selectedIndex: number
	onSelect: (actor: MentionableActor) => void
	onHoverIndex?: (index: number) => void
	className?: string
}

/**
 * `<MentionTypeahead>` — popover list of workspace members (humans + agents)
 * that the caller can render below a textarea when the user types `@`.
 *
 * Purely presentational: the parent owns the textarea, the `@` detection, the
 * filter string, and the selected-index keyboard cursor; this component owns
 * the filtered list, the avatar+name row, and click-to-pick.
 *
 * Filtering excludes the current actor (and any other ids the caller marks as
 * non-mentionable, e.g. existing participants of a DM) and any system actors —
 * `actors` already comes from `useActors`, the same list `comment-input.tsx`
 * draws from, so behaviour stays consistent across mention surfaces.
 */
export function MentionTypeahead({
	actors,
	filter,
	excludeActorIds,
	selectedIndex,
	onSelect,
	onHoverIndex,
	className,
}: MentionTypeaheadProps) {
	const excluded = useMemo(() => new Set(excludeActorIds ?? []), [excludeActorIds])
	const needle = filter.trim().toLowerCase()
	const filtered = useMemo(
		() =>
			actors
				.filter((a) => !a.isSystem && !excluded.has(a.id))
				.filter((a) => (needle ? a.name.toLowerCase().includes(needle) : true)),
		[actors, excluded, needle],
	)

	if (filtered.length === 0) return null

	return (
		<div
			aria-label="Mention a person or agent"
			className={cn(
				'absolute left-7 z-50 mt-1 max-h-48 w-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md',
				className,
			)}
		>
			{filtered.map((a, i) => (
				<button
					key={a.id}
					data-testid="mention-option"
					data-selected={i === selectedIndex || undefined}
					type="button"
					aria-pressed={i === selectedIndex}
					className={cn(
						'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
						i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
					)}
					onMouseDown={(e) => {
						// onMouseDown over onClick so the textarea's blur doesn't close
						// the popover before the click registers.
						e.preventDefault()
						onSelect({ id: a.id, name: a.name, type: a.type })
					}}
					onMouseEnter={() => onHoverIndex?.(i)}
				>
					<ActorAvatar name={a.name} type={a.type} size="sm" />
					<span className="truncate">{a.name}</span>
					<span className="ml-auto text-xs text-muted-foreground">{a.type}</span>
				</button>
			))}
		</div>
	)
}
