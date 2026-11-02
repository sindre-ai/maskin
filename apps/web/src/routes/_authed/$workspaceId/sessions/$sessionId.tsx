import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/sessions/$sessionId')({
	component: SessionLinkPage,
})

/**
 * The link an agent gives a person for a session. A session has no chat until someone opens it
 * as one, so this opens it (the server makes the chat the first time) and replaces itself with
 * the chat, which keeps Back from landing here again.
 */
function SessionLinkPage() {
	const { sessionId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let cancelled = false
		api.sessions
			.chat(sessionId, workspaceId)
			.then(({ conversation_id }) => {
				if (cancelled) return
				navigate({
					to: '/$workspaceId/chats/$conversationId',
					params: { workspaceId, conversationId: conversation_id },
					replace: true,
				})
			})
			.catch(() => {
				if (!cancelled) setFailed(true)
			})
		return () => {
			cancelled = true
		}
	}, [sessionId, workspaceId, navigate])

	if (failed) {
		return (
			<EmptyState
				title="Chat not found"
				description="This session may have been deleted or you don't have access to it."
			/>
		)
	}

	return (
		<div className="flex flex-1 items-center justify-center p-8">
			<Spinner />
		</div>
	)
}
