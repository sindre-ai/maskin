import { Composer } from '@/components/chat/chat'
import { Button } from '@/components/ui/button'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { trackForyouSparseComposerShown, trackForyouSparseComposerSubmit } from '@/lib/analytics'
import {
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

const QUICK_START_CHIPS = [
	'Help me plan a new bet',
	"What's the status on our current bets?",
] as const

interface SparseComposerProps {
	itemsCount: number
	/** Notified when focus enters/leaves the composer — used on the For You
	 *  page to yield vertical space back to the composer (e.g. hiding the
	 *  North Star prompt) while the on-screen keyboard is up on mobile. */
	onFocusChange?: (focused: boolean) => void
}

/**
 * Composer shown on the For You page when the feed is sparse (`items.length < 3`).
 * Creates a new conversation with the workspace's default chat agent (falls
 * back to the picked agent via the slash picker) and navigates to the thread
 * — the full-screen chats surface replaced the old sidebar sheet.
 *
 * Reuses `<Composer>` directly so behaviour (Enter-to-send, slash picker,
 * selection chips, error display) stays in one place.
 */
export function SparseComposer({ itemsCount, onFocusChange }: SparseComposerProps) {
	const { workspaceId } = useWorkspace()
	const defaultChatAgent = useDefaultChatAgent()
	const createConversation = useCreateConversation(workspaceId)
	const navigate = useNavigate()
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	// Snapshot at mount so the `_shown` event reflects the state that produced
	// this composer, not whatever the feed mutates into later.
	const mountedItemsCount = useRef(itemsCount)
	const [chipSending, setChipSending] = useState(false)
	const [chipError, setChipError] = useState<string | null>(null)
	const [focused, setFocused] = useState(false)
	// Read inside the visualViewport listener instead of `focused` directly —
	// the listener is attached once on mount (see below), so it must see focus
	// changes synchronously rather than waiting for the subscribing effect to
	// re-run after a render, which loses events that fire in that gap (e.g. a
	// keyboard-open resize dispatched right after focus).
	const focusedRef = useRef(false)
	// iOS Safari shrinks `visualViewport` (not `window.innerHeight`) when the
	// on-screen keyboard rises, so a normal-flow element can end up hidden
	// behind it. While focused, track how far the visual viewport has been
	// pushed up and shift the composer by that amount so it stays reachable.
	const [keyboardInset, setKeyboardInset] = useState(0)

	useEffect(() => {
		trackForyouSparseComposerShown({ items_count: mountedItemsCount.current })
	}, [])

	useEffect(() => {
		const vv = window.visualViewport
		if (!vv) return
		const updateInset = () => {
			if (!focusedRef.current) {
				setKeyboardInset(0)
				return
			}
			setKeyboardInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
		}
		vv.addEventListener('resize', updateInset)
		vv.addEventListener('scroll', updateInset)
		return () => {
			vv.removeEventListener('resize', updateInset)
			vv.removeEventListener('scroll', updateInset)
		}
	}, [])

	// Resolves the agent the message should be sent to: whatever the slash
	// picker selected, else the workspace's default chat agent.
	const defaultAgent = selection.agent ?? defaultChatAgent

	const onSend = useCallback(
		async (content: string) => {
			setChipError(null)
			if (!defaultAgent) {
				const err = new Error('No agent available to start a chat')
				setChipError(err.message)
				throw err
			}
			const hasContext =
				selection.objects.length > 0 ||
				selection.notifications.length > 0 ||
				selection.files.length > 0
			const initialMessage = hasContext
				? buildOneShotActionPrompt(
						content,
						selection.objects,
						selection.notifications,
						selection.files,
					)
				: content
			const itemsCountAtSubmit = itemsCount
			const conversation = await createConversation.mutateAsync({
				title: defaultAgent.name ?? 'New chat',
				participant_actor_ids: [defaultAgent.id],
				initial_message: initialMessage,
			})
			trackForyouSparseComposerSubmit({ items_count: itemsCountAtSubmit })
			dispatchSelection({ type: 'clear_all' })
			navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation.id },
			})
		},
		[itemsCount, defaultAgent, selection, createConversation, navigate, workspaceId],
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
		<div
			className="mx-auto space-y-2 transition-transform duration-150 md:max-w-2xl"
			style={keyboardInset > 0 ? { transform: `translateY(-${keyboardInset}px)` } : undefined}
			onFocus={() => {
				if (focused) return
				focusedRef.current = true
				setFocused(true)
				onFocusChange?.(true)
			}}
			onBlur={(e) => {
				// Ignore focus moving between the composer's own controls (textarea,
				// slash-picker buttons, send button) — only report unfocused once
				// focus actually leaves the whole composer.
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
				focusedRef.current = false
				setFocused(false)
				setKeyboardInset(0)
				onFocusChange?.(false)
			}}
		>
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
