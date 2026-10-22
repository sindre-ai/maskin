import { ExpandableDesktop } from '@/components/desktop/expandable-desktop'
import { Button } from '@/components/ui/button'
import { useSendMessage } from '@/hooks/use-conversation'
import type { MessageComputerRequest } from '@/lib/api'
import { Monitor } from 'lucide-react'
import { useState } from 'react'

interface ComputerRequestCardProps {
	workspaceId: string
	conversationId: string
	/** The agent that asked. Its own computer is the one shown: the card cannot name another. */
	agentId: string
	agentName: string
	request: MessageComputerRequest
}

type Phase = 'idle' | 'open' | 'done' | 'declined'

/**
 * The card an agent puts in chat via `show_computer` when it needs a person to act on
 * its computer (a 2FA prompt, a CAPTCHA, a confirmation). It says what to do and opens
 * the agent's live computer right in the chat. Done, or Can't do this, is what hands
 * control back: it posts a message, which is what wakes the agent.
 *
 * It never connects by itself. A chat can hold many of these, and scrolling back past an
 * old one must not wake a computer, so the view only opens when the person asks.
 */
export function ComputerRequestCard({
	workspaceId,
	conversationId,
	agentId,
	agentName,
	request,
}: ComputerRequestCardProps) {
	const sendMessage = useSendMessage(conversationId, workspaceId)
	const [phase, setPhase] = useState<Phase>('idle')

	const done = () => {
		setPhase('done')
		sendMessage.mutate({
			// Plain text: a person's own message is not rendered as markdown.
			content: "Done: I've finished on the computer. Please take a screenshot and carry on.",
		})
	}

	const decline = () => {
		setPhase('declined')
		sendMessage.mutate({
			content:
				"I couldn't do that on the computer. Carry on without it, or tell me what else you need.",
		})
	}

	if (phase === 'done' || phase === 'declined') {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<Monitor className="size-4 text-muted-foreground" aria-hidden />
				<span>
					{phase === 'done'
						? `Handed back to ${agentName}.`
						: `Told ${agentName} you couldn't do this.`}
				</span>
			</div>
		)
	}

	return (
		<section
			aria-label={`${agentName}'s computer`}
			className="mt-2 flex min-w-0 flex-col gap-3 rounded-xl border border-brand/40 bg-brand-subtle p-4"
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
				<Button type="button" size="sm" variant="outline" onClick={decline}>
					Can't do this
				</Button>
			</div>
		</section>
	)
}
