import { ParticipantsButton } from '@/components/chat/participants-button'
import { ThreadComposer } from '@/components/chat/thread-composer'
import { ThreadMessages } from '@/components/chat/thread-messages'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { useLoopChat } from '@/hooks/use-conversation'
import { useMarkConversationRead } from '@/hooks/use-mark-conversation-read'

/**
 * A loop's shared group chat — the same thread components `/chats/$conversationId`
 * renders, pointed at the loop's own conversation (created on first open).
 */
export function LoopChatPanel({ loopId, workspaceId }: { loopId: string; workspaceId: string }) {
	const { data: chat, isError } = useLoopChat(loopId, workspaceId)
	useMarkConversationRead(chat?.id ?? '', workspaceId)

	if (isError) {
		return (
			<EmptyState title="Couldn't open the loop chat" description="Reload the page to try again." />
		)
	}
	if (!chat) return <Skeleton className="h-64 w-full" />

	return (
		<div className="flex min-h-0 flex-1 flex-col [--chat-gut:clamp(14px,3vw,28px)]">
			<div className="flex shrink-0 items-center justify-between gap-2 px-[var(--chat-gut)] py-2">
				<span className="text-[12.5px] text-muted-foreground">Loop chat</span>
				<ParticipantsButton
					workspaceId={workspaceId}
					conversationId={chat.id}
					participants={chat.participants}
					createdBy={chat.createdBy}
				/>
			</div>
			<ThreadMessages workspaceId={workspaceId} conversationId={chat.id} />
			<div className="shrink-0 px-[var(--chat-gut)] pt-2.5 pb-3.5">
				<ThreadComposer workspaceId={workspaceId} conversationId={chat.id} />
			</div>
		</div>
	)
}
