import { TypingIndicator } from '@/components/chat/typing-indicator'
import { Button } from '@/components/ui/button'
import { useSession, useStopSession } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import { Square } from 'lucide-react'
import { useCallback, useState } from 'react'

interface StreamingSessionChipProps {
	sessionId: string
	workspaceId: string
	/**
	 * Called after a successful stop, so parent surfaces can flip their local
	 * "pending turn" state without waiting for the SSE stream's `done` event.
	 */
	onStopped?: () => void
	className?: string
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'paused'])

/**
 * Chip rendered while an agent session is actively streaming into the chat
 * surface. Composes the typing indicator (agent name + verb + elapsed) with a
 * single-tap Stop control that halts the container — no confirmation modal,
 * per the 2026-06-08 message-lifecycle decision. Once stopped the chip flips
 * to a muted "Stopped" state so the user sees the tap took effect
 * immediately, without waiting for the SSE stream's `done` envelope.
 */
export function StreamingSessionChip({
	sessionId,
	workspaceId,
	onStopped,
	className,
}: StreamingSessionChipProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const stopMutation = useStopSession(workspaceId)
	const [optimisticallyStopped, setOptimisticallyStopped] = useState(false)

	const isTerminal = session ? TERMINAL_STATUSES.has(session.status) : false
	const stopped = optimisticallyStopped || isTerminal

	const handleStop = useCallback(() => {
		if (stopped || stopMutation.isPending) return
		setOptimisticallyStopped(true)
		stopMutation.mutate(sessionId, {
			onSuccess: () => {
				onStopped?.()
			},
			onError: () => {
				setOptimisticallyStopped(false)
			},
		})
	}, [sessionId, stopped, stopMutation, onStopped])

	if (!session) return null
	if (stopped) {
		return (
			<output
				aria-live="polite"
				className={cn(
					'flex items-center justify-between gap-2 rounded-md border border-border bg-bg-surface px-2 py-1.5 text-text-muted text-xs',
					className,
				)}
			>
				<span>Stopped</span>
			</output>
		)
	}

	return (
		<div
			className={cn('flex flex-wrap items-center gap-2', className)}
			data-streaming-session-chip={sessionId}
		>
			<TypingIndicator sessionId={sessionId} workspaceId={workspaceId} className="min-w-0 flex-1" />
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={handleStop}
				disabled={stopMutation.isPending}
				aria-label="Stop streaming"
				className="relative h-8 shrink-0 gap-1 px-3 text-xs after:absolute after:left-1/2 after:top-1/2 after:min-h-11 after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
			>
				<Square size={12} aria-hidden fill="currentColor" />
				Stop
			</Button>
		</div>
	)
}
