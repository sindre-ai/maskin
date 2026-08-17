import { ThreadComposer } from '@/components/chat/thread-composer'
import { ThreadHeader } from '@/components/chat/thread-header'
import { ThreadMessages } from '@/components/chat/thread-messages'
import { RouteError } from '@/components/shared/route-error'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/chats/$conversationId')({
	component: ConversationThreadPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ConversationThreadPage() {
	const { conversationId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const { data: messagesData } = useConversationMessages(conversationId, workspaceId)
	const updateMe = useUpdateConversationMe(workspaceId)
	const lastMarkedRef = useRef<number | null>(null)

	// Mark the newest message read once it's loaded — mirrors the "open = read"
	// convention used elsewhere (subscriptions markRead on open).
	// biome-ignore lint/correctness/useExhaustiveDependencies: updateMe is a stable mutation handle; including it would rerun this on every render without changing behavior
	useEffect(() => {
		if (!conversation) return
		const messages = flattenMessagesOldestFirst(messagesData)
		const newest = messages[messages.length - 1]
		if (!newest || newest.id <= 0) return
		if (newest.id === conversation.last_read_message_id) return
		if (lastMarkedRef.current === newest.id) return
		lastMarkedRef.current = newest.id
		updateMe.mutate({ id: conversationId, data: { last_read_message_id: newest.id } })
	}, [conversation, messagesData, conversationId])

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ThreadHeader workspaceId={workspaceId} conversationId={conversationId} />
			<ThreadMessages workspaceId={workspaceId} conversationId={conversationId} />
			<div className="border-t border-border p-2">
				<ThreadComposer workspaceId={workspaceId} conversationId={conversationId} />
			</div>
		</div>
	)
}
