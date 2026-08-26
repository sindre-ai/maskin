import { Composer } from '@/components/chat/chat'
import { useCreateSession } from '@/hooks/use-sessions'
import type { ActorResponse } from '@/lib/api'
import {
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { useCallback, useReducer } from 'react'
import { toast } from 'sonner'

/**
 * Bottom composer on agent detail (mockup 2506–2516) — "Message {name}…",
 * which the mockup annotates as "starts a new session" (script 7489). Reuses
 * the app's one `<Composer>` so the `+` menu, attachments, dictation and
 * Enter-to-send behave exactly as they do in chat.
 *
 * Deliberately wired to `useCreateSession`, not `api.actors.run`: run resumes a
 * paused session and no-ops when one is already live (apps/dev/src/routes/
 * actors.ts:1265–1290), which would silently swallow what was just typed.
 */
export function AgentComposer({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const createSession = useCreateSession(workspaceId)
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)

	const onSend = useCallback(
		async (content: string) => {
			const actionPrompt = buildOneShotActionPrompt(
				content,
				selection.objects,
				selection.notifications,
				selection.files,
			)
			try {
				await createSession.mutateAsync({ actor_id: agent.id, action_prompt: actionPrompt })
			} catch {
				// Thrown, not toasted: the composer renders a failed send inline and
				// keeps the draft so the message can be retried without retyping.
				throw new Error(`Couldn't start a session for ${agent.name}`)
			}
			dispatchSelection({ type: 'clear_all' })
			toast.success(`${agent.name} picked it up — new session started`)
		},
		[agent.id, agent.name, createSession, selection],
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
				onRemoveAgent={() => dispatchSelection({ type: 'remove_agent' })}
				onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
				onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
				onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
			/>
			<p className="mt-1.5 px-1 text-[11.5px] text-muted-foreground">Starts a new session</p>
		</div>
	)
}
