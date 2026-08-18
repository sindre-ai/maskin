import { Composer } from '@/components/chat/chat'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { QueryStateError } from '@/components/shared/query-state'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { useBriefing } from '@/hooks/use-briefing'
import { useCreateConversation } from '@/hooks/use-conversations'
import {
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useReducer, useState } from 'react'

interface BriefDrawerProps {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

// Splits the briefing markdown into its leading H1 (rendered as the drawer's
// headline) and the rest of the document. The backend composes the briefing
// with a `# {workspace} — workspace briefing` heading; when it doesn't, the
// whole document falls through to the body.
export function splitBriefHeadline(markdown: string): { headline: string | null; body: string } {
	const match = markdown.match(/^\s*#\s+(.+?)\s*(?:\n|$)/)
	if (!match) return { headline: null, body: markdown }
	return { headline: match[1] ?? null, body: markdown.slice(match[0].length) }
}

/**
 * The v2 Brief (mockup 3414–3463): a right-side drawer opened from the top
 * nav's Brief action, over whatever screen you're on. Read mode only — the
 * mockup's audio player, "Listen instead" toggle and MENTIONED object chips
 * all need data `api.briefing.get()` does not return (audio/TTS, referenced
 * object ids, authoring agent), so they are omitted rather than faked.
 * `/$workspaceId/briefing` stays as the deep-linkable full page.
 */
export function BriefDrawer({ workspaceId, open, onOpenChange }: BriefDrawerProps) {
	const { data, isLoading, isError, error, refetch } = useBriefing(workspaceId)
	const defaultChatAgent = useDefaultChatAgent()
	const createConversation = useCreateConversation(workspaceId)
	const navigate = useNavigate()
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [sendError, setSendError] = useState<string | null>(null)

	const agent = selection.agent ?? defaultChatAgent
	const { headline, body } = splitBriefHeadline(data?.markdown ?? '')

	// Reuses the same create-conversation path the sparse composer uses, so a
	// follow-up on the brief lands in the normal chats surface.
	const onSend = useCallback(
		async (content: string) => {
			setSendError(null)
			if (!agent) {
				const err = new Error('No agent available to start a chat')
				setSendError(err.message)
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
			const conversation = await createConversation.mutateAsync({
				title: agent.name ?? 'New chat',
				participant_actor_ids: [agent.id],
				initial_message: initialMessage,
			})
			dispatchSelection({ type: 'clear_all' })
			onOpenChange(false)
			navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation.id },
			})
		},
		[agent, selection, createConversation, navigate, workspaceId, onOpenChange],
	)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
				data-testid="brief-drawer"
			>
				<div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4 pr-14">
					<div className="min-w-0">
						<SheetTitle className="text-[13.5px] font-bold">Your brief</SheetTitle>
						<p className="text-[11px] text-muted-foreground">
							The workspace snapshot that opens every agent session
						</p>
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
					{isLoading ? (
						<CardSkeleton />
					) : isError ? (
						<QueryStateError
							title="Couldn't load briefing"
							error={error instanceof Error ? error : new Error('Unknown error')}
							onRetry={() => refetch()}
						/>
					) : (
						<>
							{headline && (
								<h2 className="text-base font-bold leading-snug tracking-tight text-foreground">
									{headline}
								</h2>
							)}
							<div className="mt-3">
								<MarkdownContent content={body} />
							</div>
						</>
					)}
				</div>

				<div className="shrink-0 border-t border-border px-5 py-3">
					<Composer
						workspaceId={workspaceId}
						onSend={onSend}
						disabled={false}
						pending={false}
						surface="pulse-bar"
						placeholder={`Ask ${agent?.name ?? 'an agent'} to turn any of this into a task…`}
						textareaLabel="Ask about this brief"
						selection={selection}
						onDispatchSelection={dispatchSelection}
						onRemoveAgent={() => dispatchSelection({ type: 'remove_agent' })}
						onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
						onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
						onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
						externalError={sendError}
						onDismissExternalError={() => setSendError(null)}
					/>
				</div>
			</SheetContent>
		</Sheet>
	)
}
