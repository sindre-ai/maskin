import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useCreateComment } from '@/hooks/use-events'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { ArrowUp, MessageSquare, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

interface PersistentReplyBarProps {
	workspaceId: string
	activeId: string | null
	activeTitle: string | null
	onClear: () => void
}

const MAX_TEXTAREA_HEIGHT = 120

export function PersistentReplyBar({
	workspaceId,
	activeId,
	activeTitle,
	onClear,
}: PersistentReplyBarProps) {
	const { open } = useSidebar()
	const isMobile = useIsMobile()
	const [content, setContent] = useState('')
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const createComment = useCreateComment(workspaceId, activeId ?? '')

	useLayoutEffect(() => {
		const ta = textareaRef.current
		if (!ta) return
		ta.style.height = 'auto'
		ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
	}, [content])

	// Clear the draft whenever the active card changes
	useLayoutEffect(() => {
		setContent('')
	}, [activeId])

	const handleSend = useCallback(() => {
		const trimmed = content.trim()
		if (!trimmed || !activeId) return
		createComment.mutate(
			{ entity_id: activeId, content: trimmed },
			{
				onSuccess: () => {
					setContent('')
					toast('Reply sent')
				},
			},
		)
	}, [content, activeId, createComment])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault()
				handleSend()
			}
		},
		[handleSend],
	)

	// Fixed to the viewport bottom; offset left by the sidebar width on desktop
	const leftOffset = !isMobile && open ? 'var(--sidebar-width, 16rem)' : '0px'

	return (
		<div
			className="fixed bottom-0 right-0 z-40 border-t border-border bg-background"
			style={{ left: leftOffset, transition: 'left 200ms ease-linear' }}
		>
			<div className="px-4 py-2.5 md:px-8">
				{/* Context line */}
				<div className="mb-2 flex items-center gap-1.5">
					<MessageSquare size={11} className="shrink-0 text-muted-foreground" aria-hidden />
					<span
						className={cn(
							'flex-1 truncate text-xs',
							activeId ? 'font-medium text-foreground' : 'text-muted-foreground',
						)}
					>
						{activeId
							? `Replying to: ${activeTitle ?? 'Untitled'}`
							: 'Select a card to reply'}
					</span>
					{activeId && (
						<button
							type="button"
							aria-label="Clear selection"
							className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
							onClick={onClear}
						>
							<X size={11} />
						</button>
					)}
				</div>
				{/* Input row */}
				<div className="flex items-end gap-2">
					<textarea
						ref={textareaRef}
						rows={1}
						disabled={!activeId || createComment.isPending}
						value={content}
						onChange={(e) => setContent(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={activeId ? 'Write a message…' : 'Select a thread above to reply…'}
						className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						style={{ minHeight: '38px', maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
					/>
					<Button
						size="icon"
						className="h-[38px] w-[38px] shrink-0"
						disabled={!content.trim() || !activeId || createComment.isPending}
						onClick={handleSend}
						aria-label="Send reply"
					>
						<ArrowUp size={13} />
					</Button>
				</div>
			</div>
		</div>
	)
}
