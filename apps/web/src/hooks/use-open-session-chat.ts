import { api } from '@/lib/api'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Opens a session as a chat of its own. A session has no conversation until someone opens it
 * as one: the server makes it the first time and returns the same one after.
 */
export function useOpenSessionChat(workspaceId: string, sessionId: string) {
	const navigate = useNavigate()
	const [opening, setOpening] = useState(false)

	const open = async () => {
		setOpening(true)
		try {
			const { conversation_id } = await api.sessions.chat(sessionId, workspaceId)
			await navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation_id },
			})
		} catch {
			toast.error("Couldn't open this as a chat")
		} finally {
			setOpening(false)
		}
	}

	return { open, opening }
}
