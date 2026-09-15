import { Composer } from '@/components/chat/chat'
import { useCreateConversation } from '@/hooks/use-conversations'
import { deriveEntryAgentRole, trackChatSessionStarted } from '@/lib/analytics'
import type { ActorResponse, MessageMetadata } from '@/lib/api'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { deriveConversationTitle } from '@/lib/conversation-title'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useReducer } from 'react'
import { toast } from 'sonner'

/**
 * Bottom composer on agent detail (mockup 2506–2516) — "Message {name}…".
 *
 * Sends via `useCreateConversation`, mirroring the `/chats/new` entry point so
 * every message-to-an-agent lands on the same conversation surface: the row
 * shows up in the Chats list and the reply thread is where the user sees the
 * agent respond. The conversation responder (`apps/dev/src/services/
 * conversation-responder.ts`) spawns the underlying agent session behind the
 * conversation, so this preserves the "starts a session" outcome while fixing
 * the defect where the session ran but no chat row was ever created (Sebk
 * reported this twice; the second recurrence promoted it to a P1 fix).
 *
 * Deliberately not wired to `api.actors.run`: run resumes a paused session and
 * no-ops when one is already live (apps/dev/src/routes/actors.ts:1265–1290),
 * which would silently swallow what was just typed.
 */
export function AgentComposer({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const createConversation = useCreateConversation(workspaceId)
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)

	const onSend = useCallback(
		async (content: string) => {
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

			let conversation: Awaited<ReturnType<typeof createConversation.mutateAsync>>
			try {
				conversation = await createConversation.mutateAsync({
					title: deriveConversationTitle(content, agent.name),
					participant_actor_ids: [agent.id],
					initial_message: content,
					...(Object.keys(metadata).length > 0 ? { initial_message_metadata: metadata } : {}),
				})
			} catch {
				// Thrown, not toasted: the composer renders a failed send inline and
				// keeps the draft so the message can be retried without retyping.
				throw new Error(`Couldn't start a chat with ${agent.name}`)
			}

			trackChatSessionStarted({
				entity_id: conversation.id,
				entity_type: 'session',
				entry_point: 'agent_one_shot',
				entry_agent_role: deriveEntryAgentRole(agent.name),
				participant_count: 1,
			})
			dispatchSelection({ type: 'clear_all' })
			toast.success(`${agent.name} picked it up — new chat started`)
			navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation.id },
			})
		},
		[agent.id, agent.name, createConversation, navigate, selection, workspaceId],
	)

	return (
		<div className="pb-2" data-testid="agent-composer">
			<Composer
				workspaceId={workspaceId}
				onSend={onSend}
				disabled={false}
				pending={false}
				surface="pulse-bar"
				placeholder={`Message ${agent.name}…`}
				textareaLabel={`Message ${agent.name}`}
				selection={selection}
				onDispatchSelection={dispatchSelection}
				onRemoveAgent={(id) => dispatchSelection({ type: 'remove_agent', id })}
				onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
				onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
				onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
			/>
			<p className="mt-1.5 px-1 text-[11.5px] text-muted-foreground">Starts a new chat</p>
		</div>
	)
}
