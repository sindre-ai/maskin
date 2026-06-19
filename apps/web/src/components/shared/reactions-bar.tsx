import { Button } from '@/components/ui/button'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useReactionsByObject, useToggleReaction } from '@/hooks/use-reactions'
import type { ReactionItem } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { SmilePlus } from 'lucide-react'
import { useMemo, useState } from 'react'

// The fixed set the picker exposes. Order matches the T10 prototype's row.
const PICKER_EMOJI = ['👍', '❤️', '🎉', '🚀', '😄', '👀', '✅', '🤔'] as const

interface ReactionsBarProps {
	workspaceId: string
	objectId: string
	eventId: number
	className?: string
}

interface ReactionGroup {
	emoji: string
	count: number
	hasMine: boolean
}

function groupReactions(rows: ReactionItem[] | undefined, currentActorId: string | null) {
	if (!rows?.length) return [] as ReactionGroup[]
	const map = new Map<string, ReactionGroup>()
	for (const row of rows) {
		const existing = map.get(row.emoji)
		if (existing) {
			existing.count += 1
			if (row.actorId === currentActorId) existing.hasMine = true
		} else {
			map.set(row.emoji, {
				emoji: row.emoji,
				count: 1,
				hasMine: row.actorId === currentActorId,
			})
		}
	}
	return Array.from(map.values())
}

export function ReactionsBar({ workspaceId, objectId, eventId, className }: ReactionsBarProps) {
	const { data } = useReactionsByObject(workspaceId, objectId)
	const toggle = useToggleReaction(workspaceId, objectId)
	const currentActorId = getStoredActor()?.id ?? null
	const [pickerOpen, setPickerOpen] = useState(false)

	const groups = useMemo(
		() => groupReactions(data?.reactionsByEventId[String(eventId)], currentActorId),
		[data, eventId, currentActorId],
	)

	const handleToggle = (emoji: string, alreadyMine: boolean) => {
		toggle.mutate({ eventId, emoji, op: alreadyMine ? 'remove' : 'add' })
	}

	const handlePick = (emoji: string) => {
		const existing = groups.find((g) => g.emoji === emoji)
		handleToggle(emoji, !!existing?.hasMine)
		setPickerOpen(false)
	}

	// Hide the row entirely when there are no reactions and the comment isn't
	// hovered — the existing CSS-driven hover toolbar on ActivityComment
	// re-exposes the add button on hover via the `group/comment-hover` token.
	const hasAny = groups.length > 0

	return (
		<div
			className={cn(
				'mt-1 flex flex-wrap items-center gap-1',
				!hasAny && 'opacity-0 group-hover/comment-hover:opacity-100 focus-within:opacity-100',
				className,
			)}
		>
			{groups.map((g) => (
				<Tooltip key={g.emoji}>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => handleToggle(g.emoji, g.hasMine)}
							aria-pressed={g.hasMine}
							aria-label={
								g.hasMine ? `Remove ${g.emoji} reaction` : `Add ${g.emoji} reaction (${g.count})`
							}
							className={cn(
								'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition-colors cursor-pointer',
								g.hasMine
									? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
									: 'border-border bg-secondary/50 text-foreground hover:bg-secondary',
							)}
						>
							<span aria-hidden>{g.emoji}</span>
							<span className="font-medium tabular-nums">{g.count}</span>
						</button>
					</TooltipTrigger>
					<TooltipContent>{g.hasMine ? 'Click to remove' : 'React'}</TooltipContent>
				</Tooltip>
			))}

			<ResponsivePopover open={pickerOpen} onOpenChange={setPickerOpen}>
				<ResponsivePopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Add reaction"
						className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
					>
						<SmilePlus size={14} />
					</Button>
				</ResponsivePopoverTrigger>
				<ResponsivePopoverContent
					align="start"
					className="w-auto p-1.5"
					accessibleTitle="Pick a reaction"
				>
					<div className="flex flex-wrap gap-0.5">
						{PICKER_EMOJI.map((emoji) => (
							<button
								key={emoji}
								type="button"
								onClick={() => handlePick(emoji)}
								aria-label={`React with ${emoji}`}
								className="inline-flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-secondary transition-colors cursor-pointer"
							>
								<span aria-hidden>{emoji}</span>
							</button>
						))}
					</div>
				</ResponsivePopoverContent>
			</ResponsivePopover>
		</div>
	)
}

export { PICKER_EMOJI }
