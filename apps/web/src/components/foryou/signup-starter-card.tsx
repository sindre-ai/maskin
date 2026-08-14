import { Composer } from '@/components/chat/chat'
import { useActors } from '@/hooks/use-actors'
import { type ChatAttachment, useChat } from '@/lib/chat-context'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { useCallback, useMemo, useReducer, useState } from 'react'

const OPENING_PROMPT = 'What would you like to create?'

interface SignupStarterCardProps {
	workspaceId: string
}

// Fallback for the signup path when the T2 promote-door didn't produce a
// draft (sparse research, <3 independent sources). Renders the Strategist as
// if it had already opened a conversation — an agent bubble with an opening
// prompt and a reply input pinned below. Submit stages the message through
// chatContext with the Strategist attached, matching the SparseComposer flow.
export function SignupStarterCard({ workspaceId }: SignupStarterCardProps) {
	const { openWithContext } = useChat()
	const { data: actors } = useActors(workspaceId)
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)

	// Match the seeded Strategist by name — the development-agents template
	// creates the actor with `name: 'Strategist'`. If it isn't seeded (custom
	// workspace, deletion, etc.), fall back to no agent attachment — the
	// sidebar composer still opens and the user can pick via the slash menu.
	const strategist = useMemo(
		() => actors?.find((a) => a.type === 'agent' && a.name === 'Strategist'),
		[actors],
	)

	const onSend = useCallback(
		async (content: string) => {
			const attachments: ChatAttachment[] = []
			if (strategist) {
				attachments.push({ kind: 'agent', id: strategist.id, name: strategist.name })
			}
			await openWithContext(attachments, content)
			dispatchSelection({ type: 'clear_all' })
		},
		[openWithContext, strategist],
	)

	return (
		<div
			className="mx-auto rounded-lg border border-border bg-card md:max-w-2xl"
			data-testid="signup-starter-card"
		>
			<div className="border-b border-border px-4 py-3">
				<p className="text-xs uppercase tracking-wide text-muted-foreground">Strategist</p>
				<p className="mt-1 text-sm text-foreground">{OPENING_PROMPT}</p>
			</div>
			<div className="px-3 py-3">
				<Composer
					workspaceId={workspaceId}
					onSend={onSend}
					disabled={false}
					pending={false}
					surface="pulse-bar"
					placeholder="Reply to the Strategist…"
					textareaLabel="Reply to the Strategist"
					selection={selection}
					onDispatchSelection={dispatchSelection}
					onRemoveAgent={() => dispatchSelection({ type: 'remove_agent' })}
					onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
					onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
					onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
				/>
			</div>
		</div>
	)
}
