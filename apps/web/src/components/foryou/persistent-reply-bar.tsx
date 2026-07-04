import { CommentInput } from '@/components/activity/comment-input'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { MessageSquare, X } from 'lucide-react'
import { toast } from 'sonner'

interface PersistentReplyBarProps {
	workspaceId: string
	activeId: string | null
	activeTitle: string | null
	// Event id the reply should nest under (the active card's first unread
	// thread, or its latest thread) so replies land in the right conversation
	// instead of starting a new top-level thread. Null if unknown yet.
	parentEventId: number | null
	onClear: () => void
	// Called after a reply is successfully posted, so the parent can advance the
	// thread's read high-water-mark (replying implies you've seen the thread).
	onSent: () => void
}

// Hidden entirely until a card is active — there's nothing to reply to yet,
// so no bar (and no reserved bottom padding on the feed) until then.
export function PersistentReplyBar({
	workspaceId,
	activeId,
	activeTitle,
	parentEventId,
	onClear,
	onSent,
}: PersistentReplyBarProps) {
	const { open } = useSidebar()
	const isMobile = useIsMobile()

	if (!activeId) return null

	// Fixed to the viewport bottom; offset left by the sidebar width on desktop
	const leftOffset = !isMobile && open ? 'var(--sidebar-width, 16rem)' : '0px'

	return (
		<div
			className="fixed bottom-0 right-0 z-40 border-t border-border bg-background"
			style={{
				left: leftOffset,
				paddingBottom: 'env(safe-area-inset-bottom)',
				transition: 'left 200ms ease-linear',
			}}
		>
			<div className="px-4 py-2.5 md:px-8">
				{/* Context line */}
				<div className="mb-2 flex items-center gap-1.5">
					<MessageSquare size={11} className="shrink-0 text-muted-foreground" aria-hidden />
					<span className="flex-1 truncate text-xs font-medium text-foreground">
						Replying to: {activeTitle ?? 'Untitled'}
					</span>
					<button
						type="button"
						aria-label="Clear selection"
						className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
						onClick={onClear}
					>
						<X size={11} />
					</button>
				</div>
				{/* Input row — reuses the same composer as the object detail page
				    (attachments, @-mention autocomplete) instead of a bespoke input.
				    Keyed on activeId so switching cards mounts a fresh, empty composer
				    rather than carrying over a stale draft. */}
				<CommentInput
					key={activeId}
					workspaceId={workspaceId}
					objectId={activeId}
					parentEventId={parentEventId ?? undefined}
					mentionDropdownPlacement="above"
					onSubmitted={() => {
						toast('Reply sent')
						onSent()
					}}
				/>
			</div>
		</div>
	)
}
