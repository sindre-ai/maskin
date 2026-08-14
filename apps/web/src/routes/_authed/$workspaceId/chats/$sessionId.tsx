import { ChatList, type ChatListDefaultAgent } from '@/components/chat/chat-list'
import { ConversationView } from '@/components/chat/conversation-view'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useNotifications } from '@/hooks/use-notifications'
import { useSession, useWorkspaceSessions } from '@/hooks/use-sessions'
import type { SessionResponse } from '@/lib/api'
import { resolveDefaultAgent } from '@/lib/chats'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'

const NOT_UNREAD_STATUSES: ReadonlySet<string> = new Set(['resolved', 'dismissed'])

export const Route = createFileRoute('/_authed/$workspaceId/chats/$sessionId')({
	component: ConversationPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ConversationPage() {
	const { workspaceId, sessionId } = Route.useParams()
	const { workspace } = useWorkspace()
	const navigate = useNavigate()
	const { data: sessions, isLoading: sessionsLoading } = useWorkspaceSessions(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: notifications } = useNotifications(workspaceId, { type: 'needs_input' })

	const defaultAgentActor = useMemo(
		() => resolveDefaultAgent(actors, workspace?.settings),
		[actors, workspace],
	)
	const defaultAgent: ChatListDefaultAgent | null = defaultAgentActor
		? { id: defaultAgentActor.id, name: defaultAgentActor.name }
		: null
	// Fetch the specific session too so a deep-link lands even before the list
	// hydrates from cache (and refreshes the row after mutations elsewhere).
	const { data: fetchedSession, isLoading: sessionLoading } = useSession(sessionId, workspaceId)

	const session: SessionResponse | undefined =
		sessions?.find((s) => s.id === sessionId) ?? fetchedSession ?? undefined

	const unreadSessionIds = useMemo(() => {
		const ids = new Set<string>()
		for (const notification of notifications ?? []) {
			if (!notification.sessionId) continue
			if (NOT_UNREAD_STATUSES.has(notification.status)) continue
			ids.add(notification.sessionId)
		}
		return ids
	}, [notifications])

	const handleSelectSession = (target: SessionResponse) => {
		navigate({
			to: '/$workspaceId/chats/$sessionId',
			params: { workspaceId, sessionId: target.id },
		})
	}

	const handleStartNew = () => {
		navigate({ to: '/$workspaceId/chats', params: { workspaceId } })
	}

	return (
		<div data-testid="chat-conversation-view" className="flex min-h-0 flex-1 flex-col md:flex-row">
			<aside className="hidden md:block md:w-[292px] md:flex-none border-r border-border bg-bg-surface/40 p-3 md:overflow-y-auto">
				<PageHeader title="Chats" />
				{sessionsLoading ? (
					<ListSkeleton />
				) : (
					<ChatList
						sessions={sessions ?? []}
						actors={actors}
						unreadSessionIds={unreadSessionIds}
						defaultAgent={defaultAgent}
						onSelectSession={handleSelectSession}
						onStartNew={handleStartNew}
					/>
				)}
			</aside>
			<main className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{session ? (
					<ConversationView
						workspaceId={workspaceId}
						session={session}
						actors={actors ?? []}
						className="flex-1 min-h-0"
					/>
				) : sessionLoading ? (
					<div className="p-6">
						<ListSkeleton />
					</div>
				) : (
					<div className="p-6">
						<EmptyState
							title="Conversation not found"
							description="This chat may have been removed or moved to another workspace."
						/>
					</div>
				)}
			</main>
		</div>
	)
}
