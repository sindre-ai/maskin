import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import type { CommentRequest } from '@maskin/markdown/react/editor'
import { useEffect, useMemo, useRef, useState } from 'react'

export const TEXT_COMMENT_COMPOSE_LABEL = 'Comment on selected text'
export const TEXT_COMMENT_PLACEHOLDER = 'Add a comment…'

// Matches the editor's own mobile format bar breakpoint, so the bar and the
// compose sheet change together.
const MOBILE_QUERY = '(max-width: 640px)'

function useIsNarrow(): boolean {
	const [narrow, setNarrow] = useState(
		() => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
	)
	useEffect(() => {
		const mql = window.matchMedia(MOBILE_QUERY)
		const onChange = () => setNarrow(mql.matches)
		onChange()
		mql.addEventListener('change', onChange)
		return () => mql.removeEventListener('change', onChange)
	}, [])
	return narrow
}

interface TextCommentComposeProps {
	request: CommentRequest
	/** Called with the typed text when Save draft is pressed. */
	onSave: (body: string) => void
	/** Esc or Discard: nothing is kept. A tap outside only closes an empty box. */
	onDiscard: () => void
}

/**
 * Compose box for a comment on selected text. A 288px popover at the
 * selection on desktop, a bottom sheet with 40px buttons at 640px and below.
 * Esc or Discard closes it and leaves no draft.
 */
export function TextCommentCompose({ request, onSave, onDiscard }: TextCommentComposeProps) {
	const narrow = useIsNarrow()
	const [body, setBody] = useState('')
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const canSave = body.trim().length > 0

	// The popover follows the selection through a scroll or resize: the anchor
	// reads the selection's box live instead of keeping the one from the click.
	const anchorRef = useMemo(
		() => ({
			current: {
				getBoundingClientRect: () => {
					const { left, top, width, height } = request.getRect()
					return {
						x: left,
						y: top,
						left,
						top,
						width,
						height,
						right: left + width,
						bottom: top + height,
						toJSON: () => ({}),
					}
				},
			},
		}),
		[request],
	)

	const save = () => {
		if (canSave) onSave(body.trim())
	}

	const fields = (
		<div className="flex flex-col gap-2">
			<blockquote className="line-clamp-2 rounded-md bg-secondary px-2 py-1.5 text-xs text-muted-foreground">
				{request.anchor.quote}
			</blockquote>
			<Textarea
				ref={textareaRef}
				value={body}
				onChange={(event) => setBody(event.target.value)}
				placeholder={TEXT_COMMENT_PLACEHOLDER}
				aria-label={TEXT_COMMENT_COMPOSE_LABEL}
				className="min-h-[80px] text-xs"
			/>
			<div className="flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={cn('text-xs', narrow ? 'h-10' : 'h-7 px-2')}
					onClick={onDiscard}
				>
					Discard
				</Button>
				<Button
					type="button"
					size="sm"
					disabled={!canSave}
					className={cn('text-xs disabled:opacity-40', narrow ? 'h-10' : 'h-7 px-2')}
					onClick={save}
				>
					Save draft
				</Button>
			</div>
		</div>
	)

	if (narrow) {
		return (
			<Sheet open onOpenChange={(open) => !open && onDiscard()}>
				<SheetContent
					side="bottom"
					hideCloseButton
					aria-label={TEXT_COMMENT_COMPOSE_LABEL}
					className="rounded-t-lg p-3"
					onOpenAutoFocus={(event) => {
						event.preventDefault()
						textareaRef.current?.focus()
					}}
					// Same as the popover: a stray tap must not throw away a typed comment.
					onInteractOutside={(event) => {
						if (canSave) event.preventDefault()
					}}
				>
					<SheetTitle className="sr-only">{TEXT_COMMENT_COMPOSE_LABEL}</SheetTitle>
					{fields}
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<Popover open onOpenChange={(open) => !open && onDiscard()}>
			<PopoverAnchor virtualRef={anchorRef} />
			<PopoverContent
				align="start"
				side="bottom"
				aria-label={TEXT_COMMENT_COMPOSE_LABEL}
				className="w-72 p-3 shadow-lg"
				onOpenAutoFocus={(event) => {
					event.preventDefault()
					textareaRef.current?.focus()
				}}
				// A stray click must not throw away a typed comment; Esc and Discard do.
				onInteractOutside={(event) => {
					if (canSave) event.preventDefault()
				}}
			>
				{fields}
			</PopoverContent>
		</Popover>
	)
}
