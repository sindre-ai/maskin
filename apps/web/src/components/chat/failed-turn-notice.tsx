import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import { useRetryMessage } from '@/hooks/use-conversation'
import type { MessageResponse } from '@/lib/api'
import { RotateCcw } from 'lucide-react'

/** A permanent failure: the plain line is the message body, the provider's own text is kept for the fold. */
export function isPermanentFailure(message: MessageResponse): boolean {
	return (
		message.actorType === 'agent' &&
		message.kind === 'message' &&
		message.metadata?.final_output?.error_kind === 'permanent'
	)
}

/**
 * What sits under the plain line of a turn that failed for good: the raw error behind a closed
 * Details fold, and a Retry that asks the same agent to answer the person's message again.
 */
export function FailedTurnNotice({
	message,
	workspaceId,
	onRetried,
}: {
	message: MessageResponse
	workspaceId: string
	onRetried?: (message: MessageResponse) => void
}) {
	const canWrite = useCanWrite()
	const retryMessage = useRetryMessage(message.conversationId, workspaceId)
	const detail = message.metadata?.final_output?.error_detail
	const turnMessageId = message.metadata?.final_output?.message_id ?? message.id
	return (
		<div className="mt-2 flex flex-col items-start gap-2">
			<ViewerTooltip>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="min-h-8"
					disabled={retryMessage.isPending || !canWrite}
					onClick={() =>
						retryMessage.mutate(
							{ messageId: turnMessageId, agentId: message.actorId ?? undefined },
							{ onSuccess: () => onRetried?.(message) },
						)
					}
				>
					<RotateCcw aria-hidden />
					Retry
				</Button>
			</ViewerTooltip>
			{detail ? (
				<details className="w-full text-[12.5px] text-muted-foreground">
					<summary className="min-h-8 cursor-pointer select-none py-1.5">Details</summary>
					<pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11.5px] text-foreground">
						{detail}
					</pre>
				</details>
			) : null}
		</div>
	)
}
