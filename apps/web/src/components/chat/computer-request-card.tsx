import { ExpandableDesktop } from '@/components/desktop/expandable-desktop'
import { Button } from '@/components/ui/button'
import { useCardAnswer, useSendMessage } from '@/hooks/use-conversation'
import type { MessageComputerRequest } from '@/lib/api'
import { Monitor } from 'lucide-react'
import { useState } from 'react'

interface ComputerRequestCardProps {
	workspaceId: string
	conversationId: string
	/** The message this card is drawn in. */
	messageId: number
	/** The agent that asked. Its own computer is the one shown: the card cannot name another. */
	agentId: string
	agentName: string
	request: MessageComputerRequest
}

/** What a Done press tells the agent. Sent as a hidden nudge, so the chat does not show it. */
export const COMPUTER_DONE_MESSAGE =
	"Done: I've finished on the computer. Please take a screenshot and carry on."

type Phase = 'idle' | 'open' | 'done'

/**
 * The card an agent puts in chat via `show_computer` when it needs a person to act on
 * its computer (a 2FA prompt, a CAPTCHA, a confirmation). It says what to do and opens
 * the agent's live computer right in the chat. Done is what hands control
 * back: it posts a message, which is what wakes the agent. To skip it, the person just writes.
 *
 * It never connects by itself. A chat can hold many of these, and scrolling back past an
 * old one must not wake a computer, so the view only opens when the person asks.
 */
export function ComputerRequestCard({
	workspaceId,
	conversationId,
	messageId,
	agentId,
	agentName,
	request,
}: ComputerRequestCardProps) {
	const sendMessage = useSendMessage(conversationId, workspaceId)
	const [localPhase, setPhase] = useState<Phase>('idle')
	const answered = useCardAnswer(conversationId, workspaceId, messageId) === 'done'
	const phase: Phase = answered ? 'done' : localPhase

	const done = () => {
		setPhase('done')
		sendMessage.mutate({
			// Plain text: a person's own message is not rendered as markdown.
			content: COMPUTER_DONE_MESSAGE,
			metadata: {
				hidden_from_chat: true,
				card_answer: { message_id: messageId, outcome: 'done' },
			},
		})
	}

	if (phase === 'done') {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<Monitor className="size-4 text-muted-foreground" aria-hidden />
				<span>Handed back to {agentName}.</span>
			</div>
		)
	}

	return (
		<section
			aria-label={`${agentName}'s computer`}
			className="mt-2 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4"
		>
			<div className="flex items-start gap-2">
				<Monitor className="mt-0.5 size-4 shrink-0" aria-hidden />
				<div className="min-w-0">
					<h3 className="text-sm font-semibold">{agentName} needs your help on its computer</h3>
					<p className="mt-0.5 break-words text-xs text-muted-foreground">{request.task}</p>
				</div>
			</div>

			{phase === 'open' ? (
				<ExpandableDesktop workspaceId={workspaceId} agentId={agentId} agentName={agentName} />
			) : null}

			<div className="flex flex-wrap items-center gap-2">
				{phase === 'open' ? (
					<Button type="button" size="sm" onClick={done}>
						Done
					</Button>
				) : (
					<Button type="button" size="sm" onClick={() => setPhase('open')}>
						Open computer
					</Button>
				)}
			</div>
		</section>
	)
}
