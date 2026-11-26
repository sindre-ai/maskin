import { useConversationsInfinite } from '@/hooks/use-conversations'
import type { ConversationListItemResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { Fragment, useMemo } from 'react'

/** "Forge", "Forge and Sage", "Forge, Sage and Atlas": the words between the names. */
function joiner(index: number, total: number): string {
	if (index === total - 1) return ''
	return index === total - 2 ? ' and ' : ', '
}

/** Which agents are working in this chat, from the list the rows read (one source for both). */
export function useWorkingInChat(workspaceId: string, conversationId: string) {
	const priority = useConversationsInfinite(workspaceId, { scope: 'priority', hide_quiet: true })
	const recent = useConversationsInfinite(workspaceId, { scope: 'recent', hide_quiet: true })
	return useMemo(() => {
		const rows = [...(priority.data?.pages ?? []), ...(recent.data?.pages ?? [])].flatMap(
			(p) => p.conversations,
		)
		const chat: ConversationListItemResponse | undefined = rows.find((c) => c.id === conversationId)
		if (!chat) return []
		return (chat.working ?? []).flatMap((w) => {
			const agent = chat.participants.find((p) => p.actorId === w.agent_id)
			return agent ? [{ name: agent.actorName, sessionId: w.session_id, agentId: w.agent_id }] : []
		})
	}, [priority.data, recent.data, conversationId])
}

/**
 * The line below the person's last message while agents work: a still ring, then "Forge and Sage
 * are working", each name a link to that agent's session. No typing indicator, no animation.
 */
export function ThreadWorkingLine({
	workspaceId,
	conversationId,
}: {
	workspaceId: string
	conversationId: string
}) {
	const working = useWorkingInChat(workspaceId, conversationId)
	if (working.length === 0) return null
	return (
		<output
			data-testid="thread-working-line"
			className="ml-[39px] flex max-w-[660px] items-center gap-2 py-1 text-[13px] text-muted-foreground"
		>
			<span
				aria-hidden
				className="size-[11px] shrink-0 rounded-full border-[1.5px] border-muted-foreground border-t-foreground"
			/>
			<span>
				{working.map((w, i) => (
					<Fragment key={w.sessionId}>
						<Link
							to="/$workspaceId/sessions/$sessionId"
							params={{ workspaceId, sessionId: w.sessionId }}
							className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{w.name}
						</Link>
						{joiner(i, working.length)}
					</Fragment>
				))}{' '}
				{working.length === 1 ? 'is' : 'are'} working
			</span>
		</output>
	)
}
