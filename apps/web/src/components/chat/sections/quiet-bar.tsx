import { useChatSections } from '@/hooks/use-chat-sections'
import { useConversation } from '@/hooks/use-conversation'
import { QUIET_DAYS } from '@/lib/chat-list-sections'
import { Moon } from 'lucide-react'

/**
 * Shown above a quiet chat opened from search or the Quiet view: it is out of the main list, and
 * writing in it brings it back. Same bar pattern as Archived. A chat in a section, a pinned chat
 * and a room never go quiet, so they never show it.
 */
export function QuietBar({
	workspaceId,
	conversationId,
}: {
	workspaceId: string
	conversationId: string
}) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const { data: sections } = useChatSections(workspaceId)
	if (!conversation || conversation.archived || conversation.pinned || conversation.roomKind) {
		return null
	}
	if (sections?.sections.some((s) => s.conversationIds.includes(conversationId))) return null
	const last = conversation.lastMessageAt ? new Date(conversation.lastMessageAt) : null
	if (!last || Number.isNaN(last.getTime())) return null
	if (Date.now() - last.getTime() < QUIET_DAYS * 86_400_000) return null
	const since = last.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
	return (
		<div
			data-testid="quiet-bar"
			className="mx-[var(--chat-gut)] mb-2 flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-[13px] text-muted-foreground"
		>
			<Moon size={14} aria-hidden className="shrink-0" />
			<span className="min-w-0 flex-1">
				Quiet since {since}. Send a message and it returns to your list.
			</span>
		</div>
	)
}
