import { ChatList } from '@/components/chat/chat-list'
import { NewConversationComposer } from '@/components/foryou/new-conversation-composer'
import { PageHeader } from '@/components/layout/page-header'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useNotifications } from '@/hooks/use-notifications'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import type { SessionResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

// A session qualifies as unread when it has an open ask awaiting a human
// reply — the same needs_input signal the chat panel uses for its asks.
const NOT_UNREAD_STATUSES: ReadonlySet<string> = new Set(['resolved', 'dismissed'])

export const Route = createFileRoute('/_authed/$workspaceId/chats/')({
	component: ChatsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ChatsPage() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { data: sessions, isLoading } = useWorkspaceSessions(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: notifications } = useNotifications(workspaceId, { type: 'needs_input' })
	const [composerOpen, setComposerOpen] = useState(false)

	const unreadSessionIds = useMemo(() => {
		const ids = new Set<string>()
		for (const notification of notifications ?? []) {
			if (!notification.sessionId) continue
			if (NOT_UNREAD_STATUSES.has(notification.status)) continue
			ids.add(notification.sessionId)
		}
		return ids
	}, [notifications])

	const handleSelectSession = (session: SessionResponse) => {
		navigate({
			to: '/$workspaceId/chats/$sessionId',
			params: { workspaceId, sessionId: session.id },
		})
	}

	return (
		<div>
			<PageHeader title="Chats" />
			{isLoading ? (
				<ListSkeleton />
			) : (
				<ChatList
					sessions={sessions ?? []}
					actors={actors}
					unreadSessionIds={unreadSessionIds}
					onSelectSession={handleSelectSession}
					onStartNew={() => setComposerOpen(true)}
				/>
			)}
			<NewConversationComposer
				workspaceId={workspaceId}
				open={composerOpen}
				onOpenChange={setComposerOpen}
			/>
		</div>
	)
}
