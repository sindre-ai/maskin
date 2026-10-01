import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/chats/')({
	component: ChatsIndexPage,
})

/**
 * The no-selection pane (mockup 752–758). The v2 layout renders the
 * conversation list full-width when nothing is selected and never mounts the
 * thread pane, so this is the fallback surface rather than the common path —
 * kept because it is a shipped, reachable route.
 */
function ChatsIndexPage() {
	const { workspaceId } = useWorkspace()

	return (
		<EmptyState
			className="h-full flex-1"
			emphasis="page"
			title="Pick a conversation, or start a new one"
			description="Everything you've ever asked is still here — searchable, with the agent's reasoning attached."
			action={
				<Button asChild size="sm">
					<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
						New chat
					</Link>
				</Button>
			}
		/>
	)
}
