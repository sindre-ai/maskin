import { Composer } from '@/components/chat/chat'
import { Button } from '@/components/ui/button'
import { trackForyouSparseComposerShown, trackForyouSparseComposerSubmit } from '@/lib/analytics'
import { type ChatAttachment, useChat } from '@/lib/chat-context'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

const QUICK_START_CHIPS = [
	'Help me plan a new bet',
	"What's the status on our current bets?",
] as const

interface SparseComposerProps {
	itemsCount: number
}

/**
 * Composer shown on the For You page when the feed is sparse (`items.length < 3`).
 * Stages the message (and any selected agent/items) in `chatContext` via
 * `openWithContext` — the sidebar's composer auto-sends it as the first turn.
 *
 * Reuses `<Composer>` directly so behaviour (Enter-to-send, slash picker,
 * selection chips, error display) stays in one place.
 */
export function SparseComposer({ itemsCount }: SparseComposerProps) {
	const { openWithContext } = useChat()
	const { workspaceId } = useWorkspace()
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	// Snapshot at mount so the `_shown` event reflects the state that produced
	// this composer, not whatever the feed mutates into later.
	const mountedItemsCount = useRef(itemsCount)
	const [chipSending, setChipSending] = useState(false)
	const [chipError, setChipError] = useState<string | null>(null)

	useEffect(() => {
		trackForyouSparseComposerShown({ items_count: mountedItemsCount.current })
	}, [])

	const onSend = useCallback(
		async (content: string) => {
			setChipError(null)
			const attachments: ChatAttachment[] = []
			if (selection.agent) {
				attachments.push({ kind: 'agent', id: selection.agent.id, name: selection.agent.name })
			}
			for (const obj of selection.objects) {
				attachments.push({
					kind: 'object',
					id: obj.id,
					title: obj.title,
					type: obj.type ?? undefined,
				})
			}
			const itemsCountAtSubmit = itemsCount
			await openWithContext(attachments, content)
			trackForyouSparseComposerSubmit({ items_count: itemsCountAtSubmit })
			dispatchSelection({ type: 'clear_all' })
		},
		[itemsCount, openWithContext, selection],
	)

	const handleChipClick = useCallback(
		async (text: string) => {
			setChipSending(true)
			setChipError(null)
			try {
				await onSend(text)
			} catch (err) {
				setChipError(err instanceof Error ? err.message : 'Something went wrong')
			} finally {
				setChipSending(false)
			}
		},
		[onSend],
	)

	const showChips = itemsCount === 0

	return (
		<div className="mx-auto space-y-2 md:max-w-2xl">
			{showChips ? (
				<div className="flex flex-wrap gap-2" data-testid="sparse-composer-chips">
					{QUICK_START_CHIPS.map((text) => (
						<Button
							key={text}
							type="button"
							size="sm"
							variant="outline"
							className="h-7 rounded-full px-3 text-xs"
							disabled={chipSending}
							onClick={() => void handleChipClick(text)}
						>
							{text}
						</Button>
					))}
				</div>
			) : null}
			<div data-testid="sparse-composer">
				<Composer
					workspaceId={workspaceId}
					onSend={onSend}
					disabled={chipSending}
					pending={false}
					surface="pulse-bar"
					placeholder="Ask agents to start something…"
					textareaLabel="Start a chat with agents"
					selection={selection}
					onDispatchSelection={dispatchSelection}
					onRemoveAgent={() => dispatchSelection({ type: 'remove_agent' })}
					onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
					onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
					onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
					externalError={chipError}
					onDismissExternalError={() => setChipError(null)}
				/>
			</div>
		</div>
	)
}
