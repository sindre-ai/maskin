import { Button } from '@/components/ui/button'
import { useConversation } from '@/hooks/use-conversation'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { Archive } from 'lucide-react'

/**
 * Shown above an archived chat: it was found by search (or opened by a link) and is not in the
 * main list. Unarchive puts it back; opening it never does that by itself.
 */
export function ArchivedBar({
	workspaceId,
	conversationId,
}: {
	workspaceId: string
	conversationId: string
}) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const updateMe = useUpdateConversationMe(workspaceId)
	if (!conversation?.archived) return null
	return (
		<div
			data-testid="archived-bar"
			className="mx-[var(--chat-gut)] mb-2 flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-[13px] text-muted-foreground"
		>
			<Archive size={14} aria-hidden className="shrink-0" />
			<span className="min-w-0 flex-1 truncate">Archived.</span>
			<Button
				type="button"
				variant="link"
				size="sm"
				className="h-auto p-0 text-[13px] font-semibold"
				disabled={updateMe.isPending}
				onClick={() => updateMe.mutate({ id: conversationId, data: { archived: false } })}
			>
				Unarchive
			</Button>
		</div>
	)
}
