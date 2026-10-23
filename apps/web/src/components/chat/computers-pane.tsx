import { COMPUTER_DONE_MESSAGE } from '@/components/chat/computer-request-card'
import { ExpandableDesktop } from '@/components/desktop/expandable-desktop'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
	useSendMessage,
} from '@/hooks/use-conversation'
import type { MessageResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Monitor } from 'lucide-react'
import { useMemo } from 'react'

/**
 * What an agent is waiting on the person to do on its computer: the task of its latest
 * request, unless a person has written in the chat since. Writing in the chat is how a
 * request is answered, by Done on the card or in this pane, or by simply saying so.
 */
export function pendingComputerTasks(messages: MessageResponse[]): Map<string, string> {
	const pending = new Map<string, string>()
	for (const m of messages) {
		const task = m.metadata?.computer_request?.task
		if (m.actorType === 'agent' && task) pending.set(m.actorId, task)
		else if (m.actorType === 'human') pending.clear()
	}
	return pending
}

/**
 * The right rail's Computers tab: a small live view of each agent's computer in the
 * chat. Expanding one opens it large, where the person can take control; when the agent
 * asked for help, Done sits under the view, in both sizes.
 */
export function ComputersPane({
	workspaceId,
	conversationId,
	className,
}: { workspaceId: string; conversationId: string; className?: string }) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const { data } = useConversationMessages(conversationId, workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	const pending = useMemo(() => pendingComputerTasks(flattenMessagesOldestFirst(data)), [data])
	const agents = (conversation?.participants ?? []).filter((p) => p.actorType === 'agent')

	return (
		<div
			className={cn('flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-4', className)}
			aria-label="Computers"
		>
			{agents.length === 0 ? (
				<EmptyState
					title="No computers yet"
					description="When an agent joins this chat, its computer shows up here."
				/>
			) : (
				agents.map((agent) => {
					const task = pending.get(agent.actorId)
					return (
						<section key={agent.actorId} className="flex min-w-0 flex-col gap-2">
							{task ? (
								<div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
									<Monitor className="mt-0.5 size-4 shrink-0" aria-hidden />
									<p className="min-w-0 break-words text-xs text-muted-foreground">
										<span className="font-medium text-foreground">
											{agent.actorName} needs your help:
										</span>{' '}
										{task}
									</p>
								</div>
							) : null}
							<ExpandableDesktop
								workspaceId={workspaceId}
								agentId={agent.actorId}
								agentName={agent.actorName}
								actions={
									task ? (
										<Button
											type="button"
											size="sm"
											disabled={sendMessage.isPending}
											onClick={() =>
												sendMessage.mutate({
													content: COMPUTER_DONE_MESSAGE,
													metadata: { hidden_from_chat: true },
												})
											}
										>
											Done
										</Button>
									) : undefined
								}
							/>
						</section>
					)
				})
			)}
		</div>
	)
}
