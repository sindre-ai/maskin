import { ThreadView } from '@/components/chat/threads-pane'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@/components/ui/sheet'
import type { ConversationThread } from '@/hooks/use-conversation-threads'
import { useIsDesktopViewport } from '@/hooks/use-mobile'
import { usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

/** The chat's right rail is 400px, 440px from xl; the page makes room for the same width. */
const PANEL_WIDTH = 'clamp(400px, 30vw, 440px)'

/**
 * A background run as the right side panel the chat page has: a thread of the session, nothing
 * else. Desktop pins it to the right edge and pushes the page aside; smaller screens open it as
 * a bottom sheet, like the chat.
 */
export function SessionPanel({
	workspaceId,
	thread,
	title,
	onClose,
}: {
	workspaceId: string
	thread: ConversationThread
	title: string
	onClose: () => void
}) {
	const isDesktop = useIsDesktopViewport()
	const { setContentPush } = usePageHeader()

	useEffect(() => {
		if (!isDesktop) return
		setContentPush(PANEL_WIDTH)
		return () => setContentPush(undefined)
	}, [isDesktop, setContentPush])

	const view = (
		<div className="flex h-full min-h-0 w-full flex-col bg-surface-sunken" aria-label="Session">
			<ThreadView
				workspaceId={workspaceId}
				conversationId={null}
				thread={thread}
				title={title}
				onClose={onClose}
				closeLabel="Close session"
			/>
		</div>
	)

	if (isDesktop) {
		return (
			<aside
				aria-label="Session panel"
				style={{ width: PANEL_WIDTH }}
				className="duration-slide ease-emphasized fixed inset-y-0 right-0 z-30 border-l border-border motion-safe:animate-in motion-safe:slide-in-from-right motion-reduce:animate-none"
			>
				{view}
			</aside>
		)
	}

	return (
		<Sheet open onOpenChange={(open) => !open && onClose()}>
			<SheetContent side="bottom" className="h-[85dvh] rounded-t-lg p-0" hideCloseButton>
				<SheetHeader className="sr-only">
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>The agent's work on this run, as a chat.</SheetDescription>
				</SheetHeader>
				{view}
			</SheetContent>
		</Sheet>
	)
}
