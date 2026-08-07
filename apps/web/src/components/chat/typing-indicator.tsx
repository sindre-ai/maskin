import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { useActiveSessionsForConversation } from '@/hooks/use-sessions'

interface TypingIndicatorProps {
	workspaceId: string
	conversationId: string
}

/**
 * Renders a compact badge per in-flight agent turn on this conversation — an
 * agent session is "typing" the same way `AgentWorkingBadge` already shows an
 * agent working on a mention. Multiple agents can be typing at once since
 * every agent participant independently evaluates each new message.
 */
export function TypingIndicator({ workspaceId, conversationId }: TypingIndicatorProps) {
	const { data: sessions } = useActiveSessionsForConversation(workspaceId, conversationId)
	if (!sessions || sessions.length === 0) return null

	return (
		<div className="flex flex-wrap gap-1.5 px-1" aria-live="polite">
			{sessions.map((session) => (
				<AgentWorkingBadge key={session.id} sessionId={session.id} workspaceId={workspaceId} />
			))}
		</div>
	)
}
