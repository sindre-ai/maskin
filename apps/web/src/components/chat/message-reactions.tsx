import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MessageReaction } from '@/lib/api'
import { cn } from '@/lib/cn'
import { QUICK_REACTIONS, hasReacted, reactionLabel } from '@/lib/message-reactions'
import { SmilePlus } from 'lucide-react'
import { useState } from 'react'

// Padded to a 32px target on phones and wherever any coarse pointer exists (an iPad with a
// trackpad reports a fine primary pointer), the same rule the Reply button follows.
const REACT_BUTTON_CLASS =
	'rounded p-2.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 md:p-1 any-pointer-coarse:p-2.5'

/**
 * The "add a reaction" button in a message's action row. It sits in the row beside Copy and
 * Reply, so it is as reachable as they are: always visible on touch, and revealed by hover or
 * keyboard focus on a pointer device. It opens a small picker of the five quick emoji; picking
 * one you already used takes it back, exactly as the chip under the message does.
 */
export function ReactButton({
	reactions,
	onToggle,
	disabled = false,
	onOpenChange,
}: {
	reactions: MessageReaction[] | undefined
	onToggle: (emoji: string) => void
	disabled?: boolean
	/** Told when the picker opens or closes, so the action row can stay visible while it is open. */
	onOpenChange?: (open: boolean) => void
}) {
	const [open, setOpenState] = useState(false)
	const setOpen = (next: boolean) => {
		setOpenState(next)
		onOpenChange?.(next)
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="Add reaction"
					disabled={disabled}
					className={REACT_BUTTON_CLASS}
				>
					<SmilePlus size={12} aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				className="flex w-auto items-center gap-0.5 p-1"
				aria-label="React with an emoji"
			>
				{QUICK_REACTIONS.map((emoji) => {
					const mine = hasReacted(reactions, emoji)
					return (
						<button
							key={emoji}
							type="button"
							aria-pressed={mine}
							aria-label={mine ? `Take back ${emoji}` : `React with ${emoji}`}
							onClick={() => {
								onToggle(emoji)
								setOpen(false)
							}}
							className={cn(
								'flex size-9 items-center justify-center rounded-md text-lg transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
								mine && 'bg-foreground/10',
							)}
						>
							<span aria-hidden>{emoji}</span>
						</button>
					)
				})}
			</PopoverContent>
		</Popover>
	)
}

/**
 * The emoji under a message: one pill per emoji with its count, filled when you used it.
 * Pressing a pill adds or takes back your reaction. Hover or focus names who reacted.
 */
export function ReactionChips({
	reactions,
	meId,
	onToggle,
	disabled = false,
	className,
}: {
	reactions: MessageReaction[] | undefined
	meId: string | undefined
	onToggle: (emoji: string) => void
	disabled?: boolean
	className?: string
}) {
	if (!reactions || reactions.length === 0) return null
	return (
		<TooltipProvider delayDuration={150}>
			<div className={cn('flex flex-wrap items-center gap-1', className)}>
				{reactions.map((reaction) => {
					const label = reactionLabel(reaction, meId)
					return (
						<Tooltip key={reaction.emoji}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-pressed={reaction.reactedByMe}
									aria-label={`${label}. ${reaction.reactedByMe ? 'Press to take it back' : 'Press to add yours'}`}
									disabled={disabled}
									onClick={() => onToggle(reaction.emoji)}
									className={cn(
										'inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 any-pointer-coarse:min-h-8',
										reaction.reactedByMe
											? 'border-foreground/40 bg-foreground/10 text-foreground'
											: 'border-border bg-card text-muted-foreground hover:text-foreground',
									)}
								>
									<span aria-hidden>{reaction.emoji}</span>
									<span aria-hidden className="font-semibold tabular-nums">
										{reaction.count}
									</span>
								</button>
							</TooltipTrigger>
							<TooltipContent>{label}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</TooltipProvider>
	)
}
