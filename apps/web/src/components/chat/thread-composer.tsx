import { Composer } from '@/components/chat/chat'
import { useConversation, useSendMessage } from '@/hooks/use-conversation'
import type { MessageMetadata } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { useCallback, useReducer, useState } from 'react'

interface ThreadComposerProps {
	workspaceId: string
	conversationId: string
}

/**
 * Adapts the existing `<Composer>` (attach/upload/slash-picker/send) to the
 * conversation send path. Objects/notifications picked via the slash picker
 * are sent as structured `metadata.context_objects` / `context_notifications`
 * (rendered as chips by `MessageBubble`) rather than inlined into the message
 * text — the backend rebuilds the equivalent context block for the agent's
 * prompt from that metadata (see `conversation-responder.ts`). An agent
 * picked via the "Agent" button becomes an `@mention` so the responder
 * pipeline's mention fast-path picks it up (and auto-joins them as a
 * participant if they weren't one already).
 */
export function ThreadComposer({ workspaceId, conversationId }: ThreadComposerProps) {
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	const { data: conversation } = useConversation(conversationId, workspaceId)

	const handleSend = useCallback(
		async (content: string) => {
			setError(null)
			const metadata: MessageMetadata = {}
			if (selection.files.length > 0) {
				metadata.attachments = selection.files.map((f) => ({
					file_id: f.fileId,
					name: f.name,
					mime_type: f.mimeType ?? 'application/octet-stream',
					size_bytes: f.sizeBytes,
				}))
			}
			if (selection.objects.length > 0) {
				metadata.context_objects = selection.objects.map((o) => ({
					id: o.id,
					...(o.title ? { title: o.title } : {}),
					...(o.type ? { type: o.type } : {}),
				}))
			}
			if (selection.notifications.length > 0) {
				metadata.context_notifications = selection.notifications.map((n) => ({
					id: n.id,
					...(n.title ? { title: n.title } : {}),
				}))
			}
			if (selection.agent) {
				metadata.mentions = [selection.agent.id]
			}

			try {
				await sendMessage.mutateAsync({
					content,
					...(Object.keys(metadata).length > 0 ? { metadata } : {}),
				})
				dispatch({ type: 'clear_all' })
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to send message')
				throw err
			}
		},
		[selection, sendMessage],
	)

	// Name who you are answering (mockup 7850). "Message this conversation"
	// gave the composer no subject in a thread whose other party is the whole
	// point of opening it; an @mention picked in the composer overrides the
	// name because that mention, not the thread's lead, is who replies.
	const self = getStoredActor()
	const counterpart =
		selection.agent?.name ??
		conversation?.participants.find((p) => p.actorId !== self?.id)?.actorName
	const placeholder = counterpart ? `Reply to ${counterpart}…` : 'Message this conversation'

	return (
		<Composer
			workspaceId={workspaceId}
			onSend={handleSend}
			disabled={false}
			pending={sendMessage.isPending}
			surface="sheet"
			placeholder={placeholder}
			selection={selection}
			onDispatchSelection={dispatch}
			onRemoveAgent={() => dispatch({ type: 'remove_agent' })}
			onRemoveObject={(id) => dispatch({ type: 'remove_object', id })}
			onRemoveNotification={(id) => dispatch({ type: 'remove_notification', id })}
			onRemoveFile={(fileId) => dispatch({ type: 'remove_file', fileId })}
			externalError={error}
			onDismissExternalError={() => setError(null)}
			// The accessible name stays constant while the visible placeholder
			// names the counterpart — a name that changed with the thread's lead
			// would make the same control a different control to a screen reader.
			textareaLabel="Message this conversation"
		/>
	)
}
