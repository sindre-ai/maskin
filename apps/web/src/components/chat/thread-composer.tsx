import { Composer } from '@/components/chat/chat'
import { useSendMessage } from '@/hooks/use-conversation'
import type { MessageMetadata } from '@/lib/api'
import {
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { useCallback, useReducer, useState } from 'react'

interface ThreadComposerProps {
	workspaceId: string
	conversationId: string
}

/**
 * Adapts the existing `<Composer>` (attach/upload/slash-picker/send) to the
 * conversation send path. Objects/notifications picked via the slash picker
 * are inlined into the message text — the backend's message schema only
 * defines `metadata.attachments` (files) and `metadata.mentions`, the same
 * constraint the persistent session's input endpoint has today, so this
 * reuses `buildOneShotActionPrompt` rather than inventing a new context
 * channel. An agent picked via the "Agent" button becomes an `@mention` so
 * the responder pipeline's mention fast-path picks it up.
 */
export function ThreadComposer({ workspaceId, conversationId }: ThreadComposerProps) {
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const sendMessage = useSendMessage(conversationId, workspaceId)

	const handleSend = useCallback(
		async (content: string) => {
			setError(null)
			const hasContext = selection.objects.length > 0 || selection.notifications.length > 0
			const enrichedContent = hasContext
				? buildOneShotActionPrompt(content, selection.objects, selection.notifications, [])
				: content

			const metadata: MessageMetadata = {}
			if (selection.files.length > 0) {
				metadata.attachments = selection.files.map((f) => ({
					file_id: f.fileId,
					name: f.name,
					mime_type: f.mimeType ?? 'application/octet-stream',
					size_bytes: f.sizeBytes,
				}))
			}
			if (selection.agent) {
				metadata.mentions = [selection.agent.id]
			}

			try {
				await sendMessage.mutateAsync({
					content: enrichedContent,
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

	return (
		<Composer
			workspaceId={workspaceId}
			onSend={handleSend}
			disabled={false}
			pending={sendMessage.isPending}
			surface="sheet"
			placeholder="Message this conversation"
			selection={selection}
			onDispatchSelection={dispatch}
			onRemoveAgent={() => dispatch({ type: 'remove_agent' })}
			onRemoveObject={(id) => dispatch({ type: 'remove_object', id })}
			onRemoveNotification={(id) => dispatch({ type: 'remove_notification', id })}
			onRemoveFile={(fileId) => dispatch({ type: 'remove_file', fileId })}
			externalError={error}
			onDismissExternalError={() => setError(null)}
			textareaLabel="Message this conversation"
		/>
	)
}
