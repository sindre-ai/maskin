import { useStar } from '@/hooks/use-star'
import { cn } from '@/lib/cn'
import { Star } from 'lucide-react'
import type { KeyboardEvent } from 'react'

interface DetailMetaStarProps {
	objectId: string
}

/** The star button on the Object detail meta row (SPEC §D5).
 *
 *  Sits left of the status chip. Outline when off (--ink-3), filled amber
 *  (#f59e0b) when on, 60% opacity while the server round-trip is in flight;
 *  reverts + toasts on error via `useStar`.
 *
 *  Keyboard: focus the button and press `s` (or Enter / Space) to toggle.
 *  `aria-pressed` reflects the current state; `aria-label` flips between
 *  "Star this object" and "Starred (click to remove)". */
export function DetailMetaStar({ objectId }: DetailMetaStarProps) {
	const { isStarred, isSaving, toggle } = useStar(objectId)

	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		// A native button already handles Enter/Space, so this is the `s`
		// shortcut only — modifiers reserve the browser's own bindings.
		if (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
			e.preventDefault()
			toggle()
		}
	}

	return (
		<button
			type="button"
			aria-pressed={isStarred}
			aria-label={isStarred ? 'Starred (click to remove)' : 'Star this object'}
			onClick={(e) => {
				e.preventDefault()
				e.stopPropagation()
				toggle()
			}}
			onKeyDown={onKeyDown}
			className={cn(
				'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors',
				'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				// SPEC: outline star in --ink-3 (muted-foreground/border-strong) off,
				// hover → --ink-2 (foreground). Filled amber (#f59e0b) when on.
				isStarred
					? 'text-[#f59e0b] hover:text-[#f59e0b]/90'
					: 'text-border-strong hover:text-muted-foreground',
				// SPEC: 60% opacity while saving; snap to final state on response.
				isSaving && 'opacity-60',
			)}
		>
			<Star size={14} className={isStarred ? 'fill-current' : undefined} aria-hidden="true" />
		</button>
	)
}
