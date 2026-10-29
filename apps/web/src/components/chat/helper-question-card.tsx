import { QuestionOptions } from '@/components/chat/question-options'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import type { MessageQuestion } from '@/lib/api'
import { CircleHelp } from 'lucide-react'

interface HelperQuestionCardProps {
	workspaceId: string
	conversationId: string
	/** `messages.id` of the message carrying the question. */
	questionMessageId: number
	actorId: string
	actorName: string
	question: MessageQuestion
	answered: boolean
	/** Opens the helper's thread; absent when the chat has no Threads pane. */
	onViewThread?: (sessionId: string) => void
}

/**
 * A question a helper agent (one another agent started from this chat) is asking
 * the person. Drawn as a card, like the handoff card it belongs to, rather than
 * as a chat message: the helper is not a participant of this chat, and the card
 * says the question is being put to the person from outside the conversation.
 * Answering goes to the helper's own session.
 */
export function HelperQuestionCard({
	workspaceId,
	conversationId,
	questionMessageId,
	actorId,
	actorName,
	question,
	answered,
	onViewThread,
}: HelperQuestionCardProps) {
	return (
		<div className="ml-[39px] max-w-[660px] rounded-xl border border-border bg-card px-4 py-3">
			<div className="flex items-start gap-3">
				<CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
						<span className="min-w-0 truncate text-[14px] font-semibold text-foreground">
							Needs your input
						</span>
						<span className="flex shrink-0 items-center gap-1.5">
							<ActorAvatar
								id={actorId}
								name={actorName}
								type="agent"
								size="sm"
								className="shrink-0"
							/>
							<span className="text-[12px] text-muted-foreground">{actorName}</span>
						</span>
					</div>
					<QuestionOptions
						conversationId={conversationId}
						workspaceId={workspaceId}
						questionMessageId={questionMessageId}
						question={question}
						answered={answered}
						trailingAction={
							onViewThread ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => onViewThread(question.session_id)}
								>
									View thread
								</Button>
							) : undefined
						}
					/>
				</div>
			</div>
		</div>
	)
}
