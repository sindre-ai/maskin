import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/chats/')({
	component: ChatsIndexPage,
})

function ChatsIndexPage() {
	const { workspaceId } = useWorkspace()

	return (
		<EmptyState
			className="h-full flex-1"
			title="Pick a conversation, or start a new one"
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
