import { ThreadComposer } from '@/components/chat/thread-composer'
import { ThreadHeader } from '@/components/chat/thread-header'
import { ThreadMessages } from '@/components/chat/thread-messages'
import { RouteError } from '@/components/shared/route-error'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useSessionBudgetStopToast } from '@/hooks/use-conversation-activity'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
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
	// Feature-flag boundary for the chats v4 polish bet (bet/bdda1c1e-chats-v4-polish).
	// Read once at this route per the feature-flags rule
	// (`.claude/rules/feature-flags.md`) and threaded down as boolean props. Each
	// delta is additionally gated by its own sub-flag (`.header` / `.banner` /
	// `.bubbles`) so a single delta can be reverted without dropping the rest.
	const chatsV4Enabled = useFeatureFlag('chats-v4-polish')
	const headerV4Enabled = useFeatureFlag('chats-v4-polish.header')
	const bannerV4Enabled = useFeatureFlag('chats-v4-polish.banner')
	const bubblesV4Enabled = useFeatureFlag('chats-v4-polish.bubbles')
	// Feature-flag boundary for the chat thread `HANDED OFF` sub-agent
	// delegation strip bet (bet/444b-handed-off-strip). Read once at this
	// route, threaded down as a plain boolean prop through ThreadMessages →
	// MessageBubble — the same one-boundary-per-feature shape the v4 polish
	// flags use above.
	const handedOffStripEnabled = useFeatureFlag('handed-off-strip')
	const lastMarkedRef = useRef<number | null>(null)
	useSessionBudgetStopToast(workspaceId, conversationId)

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
			<ThreadHeader
				workspaceId={workspaceId}
				conversationId={conversationId}
				v4Polish={chatsV4Enabled && headerV4Enabled}
			/>
			<ThreadMessages
				workspaceId={workspaceId}
				conversationId={conversationId}
				v4PolishBanner={chatsV4Enabled && bannerV4Enabled}
				v4PolishBubbles={chatsV4Enabled && bubblesV4Enabled}
				handedOffStripEnabled={handedOffStripEnabled}
			/>
			{/* No rule above the composer (mockup 517): the composer draws its own
			    border, and a second full-bleed hairline behind it cut the thread in
			    half. The gutter matches the header's and the transcript's so the
			    three stack on one vertical edge. */}
			<div className="shrink-0 px-[var(--chat-gut)] pt-2.5 pb-3.5">
				<ThreadComposer workspaceId={workspaceId} conversationId={conversationId} />
			</div>
		</div>
	)
}
