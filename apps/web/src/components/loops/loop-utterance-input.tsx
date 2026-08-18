import { Composer } from '@/components/chat/chat'
import { Button } from '@/components/ui/button'
import type { LoopSummary } from '@/lib/api'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { forwardRef, useCallback } from 'react'

// Shown when the loop has no change history yet (mockup 2017–2022) — the
// operator gets three things they could say instead of a blank bar.
const SUGGESTIONS = [
	'Close cycles faster',
	'Ask me before anything ships',
	'Hand the review to someone else',
]

/**
 * "Change by talking" composer, sticky at the bottom of the loop reader column
 * (mockup 1989–2036). Submitting a plain-language utterance opens a new chat
 * with this loop attached, so the operator edits the loop by describing what
 * should change rather than filling in a builder.
 */
export const LoopUtteranceInput = forwardRef<
	HTMLDivElement,
	{
		loop: LoopSummary
		/** Rendered above the composer — the PROPOSED EDIT card, when there is one. */
		children?: React.ReactNode
		/** Offer the suggestion chips (no change history yet). */
		showSuggestions?: boolean
		/** True while a voice capture is running — renders the listening indicator. */
		listening?: boolean
		/** Return true to consume the utterance in place (the PROPOSED EDIT card).
		 *  Returning false hands off to a chat with the loop attached, which is the
		 *  only path for loops that carry no plan snapshot. */
		onUtterance?: (utterance: string) => boolean
	}
>(function LoopUtteranceInput({ loop, children, showSuggestions, listening, onUtterance }, ref) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()

	const submit = useCallback(
		async (utterance: string) => {
			if (onUtterance?.(utterance)) return
			navigate({
				to: '/$workspaceId/chats/new',
				params: { workspaceId },
				search: { objectId: loop.id, objectTitle: loop.name ?? undefined, objectType: 'loop' },
			})
		},
		[navigate, workspaceId, loop.id, loop.name, onUtterance],
	)

	return (
		<div ref={ref} className="sticky bottom-0 z-10 mt-6 bg-background">
			<div
				aria-hidden="true"
				className="pointer-events-none h-5 bg-gradient-to-b from-transparent to-background"
			/>
			<div className="pb-[max(0.625rem,env(safe-area-inset-bottom))]">
				{children}
				{showSuggestions && (
					<div className="mb-2.5 flex flex-wrap gap-2" aria-label="Suggested changes">
						{SUGGESTIONS.map((suggestion) => (
							<Button
								key={suggestion}
								variant="outline"
								size="sm"
								className="rounded-full"
								onClick={() => void submit(suggestion)}
							>
								{suggestion}
							</Button>
						))}
					</div>
				)}
				{listening && (
					<div className="mb-2.5 flex items-center gap-2">
						<span
							aria-hidden="true"
							className="size-1.5 shrink-0 animate-pulse rounded-full bg-error"
						/>
						<span className="text-[11.5px] font-semibold text-muted-foreground">
							Listening — speak in plain words
						</span>
					</div>
				)}
				<Composer
					workspaceId={workspaceId}
					onSend={submit}
					disabled={false}
					pending={false}
					surface="pulse-bar"
					placeholder="Listening — speak in plain words"
					selection={EMPTY_CHAT_SELECTION}
					onRemoveAgent={() => {}}
					onRemoveObject={() => {}}
					onRemoveNotification={() => {}}
					onRemoveFile={() => {}}
					textareaLabel="Say what should change about this loop"
				/>
			</div>
		</div>
	)
})
