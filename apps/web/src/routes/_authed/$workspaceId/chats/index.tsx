import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useNewDesign } from '@/lib/new-design-context'
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
	// v2 branch — the flag is read once at the workspace shell boundary and
	// reaches this leaf as a boolean (see `chats.tsx`).
	const newDesign = useNewDesign()

	return (
		<EmptyState
			className="h-full flex-1"
			emphasis={newDesign ? 'page' : undefined}
			title="Pick a conversation, or start a new one"
			description={
				newDesign
					? "Everything you've ever asked is still here — searchable, with the agent's reasoning attached."
					: undefined
			}
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
