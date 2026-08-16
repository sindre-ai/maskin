import { ChatList, type ChatListDefaultAgent } from '@/components/chat/chat-list'
import { NewConversationComposer } from '@/components/foryou/new-conversation-composer'
import { PageHeader } from '@/components/layout/page-header'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useNotifications } from '@/hooks/use-notifications'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import type { SessionResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useChat } from '@/lib/chat-context'
import { resolveDefaultAgent } from '@/lib/chats'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

// A session qualifies as unread when it has an open ask awaiting a human
// reply — the same needs_input signal the chat panel uses for its asks.
const NOT_UNREAD_STATUSES: ReadonlySet<string> = new Set(['resolved', 'dismissed'])

const COS_EXAMPLES: string[] = [
	"Summarise this week's shipped bets",
	'Get me a read on Q3 retention',
	'Draft a reply to Christian on booking',
]

export const Route = createFileRoute('/_authed/$workspaceId/chats/')({
	component: ChatsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ChatsPage() {
	const { workspace, workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { openWithContext } = useChat()
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

	// Mirror the default-agent resolver used by the workspace layout: prefer the
	// workspace-level `default_agent_id` when set, else fall back to an actor
	// named "Chief of Staff". Keeps every pre-CoS workspace unchanged.
	const defaultAgentActor = useMemo(
		() => resolveDefaultAgent(actors, workspace?.settings),
		[actors, workspace],
	)
	const defaultAgent: ChatListDefaultAgent | null = defaultAgentActor
		? { id: defaultAgentActor.id, name: defaultAgentActor.name }
		: null

	const viewerFirstName = useMemo(() => {
		const stored = getStoredActor()
		if (!stored?.name) return null
		const first = stored.name.trim().split(/\s+/)[0]
		return first && first.length > 0 ? first : null
	}, [])

	// Empty-state CoS greeting only when the workspace's default agent is
	// actually the Chief of Staff — other default agents keep the generic
	// "Start a new one" copy so we don't misattribute a routing model.
	const emptyGreeting = useMemo(() => {
		if (!defaultAgentActor || defaultAgentActor.name !== 'Chief of Staff') return null
		const hello = viewerFirstName ? `Hi ${viewerFirstName} — ` : ''
		return {
			greeting: `${hello}I'm your Chief of Staff.`,
			description:
				"Say what you want done. I'll ask the right specialist, spin up a bet if it's bigger, or handle it myself if it's small enough. Nothing leaves this chat without you knowing.",
			examples: COS_EXAMPLES,
			onExample: (prompt: string) => {
				openWithContext(
					[{ kind: 'agent', id: defaultAgentActor.id, name: defaultAgentActor.name }],
					prompt,
				)
			},
		}
	}, [defaultAgentActor, openWithContext, viewerFirstName])

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
					defaultAgent={defaultAgent}
					emptyGreeting={emptyGreeting}
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
