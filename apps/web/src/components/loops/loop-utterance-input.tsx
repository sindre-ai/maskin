import { Composer } from '@/components/chat/chat'
import { FLOATING_CONTROLS } from '@/components/shared/floating-footer'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { useCanWrite } from '@/hooks/use-can-write'
import type { LoopSummary } from '@/lib/api'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { VIEWER_READ_ONLY_MESSAGE } from '@/lib/workspace-role'
import { useNavigate } from '@tanstack/react-router'
import { forwardRef, useCallback } from 'react'

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
		/** Idle prompt in the composer; defaults to the change-by-talking line. */
		placeholder?: string
		/** True while a voice capture is running — renders the listening indicator. */
		listening?: boolean
		/** Return true to consume the utterance in place (the PROPOSED EDIT card).
		 *  Returning false hands off to a chat with the loop attached, which is the
		 *  only path for loops that carry no plan snapshot. */
		onUtterance?: (utterance: string) => boolean
	}
>(function LoopUtteranceInput({ loop, children, placeholder, listening, onUtterance }, ref) {
	const { workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const navigate = useNavigate()

	const submit = useCallback(
		async (utterance: string) => {
			if (!canWrite) return
			if (onUtterance?.(utterance)) return
			navigate({
				to: '/$workspaceId/chats/new',
				params: { workspaceId },
				search: { objectId: loop.id, objectTitle: loop.name ?? undefined, objectType: 'loop' },
			})
		},
		[navigate, workspaceId, loop.id, loop.name, onUtterance, canWrite],
	)

	return (
		// No background: the content shows through around the composer, and only the composer takes clicks.
		<div
			ref={ref}
			className={`pointer-events-none sticky bottom-0 z-10 mt-6 pt-4 ${FLOATING_CONTROLS}`}
		>
			<div className="pb-[max(0.625rem,env(safe-area-inset-bottom))]">
				{children}
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
				<ViewerTooltip className="block w-full">
					<Composer
						workspaceId={workspaceId}
						onSend={submit}
						disabled={!canWrite}
						pending={false}
						surface="pulse-bar"
						placeholder={
							canWrite
								? (placeholder ?? 'Say what should change about this flow')
								: VIEWER_READ_ONLY_MESSAGE
						}
						selection={EMPTY_CHAT_SELECTION}
						onRemoveAgent={() => {}}
						onRemoveObject={() => {}}
						onRemoveNotification={() => {}}
						onRemoveFile={() => {}}
						textareaLabel="Say what should change about this flow"
					/>
				</ViewerTooltip>
			</div>
		</div>
	)
})
