import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { useDuration } from '@/hooks/use-duration'
import type { SpawnedSession } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationMs } from '@/lib/format-duration'
import { handoffTitle, statusToPill, threadPill } from '@/lib/handed-off-strip'
import { Hand } from 'lucide-react'

interface HandoffCardProps {
	session: SpawnedSession
	onViewThread: (sessionId: string) => void
}

/**
 * One card per session an agent handed work to, rendered under the message that
 * handed it off. Replaces the strip's row list when the Threads pane is
 * available: the card says what was delegated and to whom, shows live state, and
 * its button opens the session as a thread beside the chat.
 */
export function HandoffCard({ session, onViewThread }: HandoffCardProps) {
	const pill = statusToPill(session.status)
	const elapsedRunning = useDuration(pill === 'WORKING' ? session.startedAt : null)
	const elapsed =
		pill === 'DONE' && session.durationMs && session.durationMs > 0
			? formatDurationMs(session.durationMs)
			: pill === 'WORKING'
				? elapsedRunning
				: null
	const display = threadPill(session.status, session.awaiting !== null)
	if (!pill || !display) return null

	return (
		<div className="rounded-xl border border-border bg-card px-4 py-3">
			<div className="flex items-start gap-3">
				<Hand size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
						<span className="min-w-0 truncate text-[14px] font-semibold text-foreground">
							{handoffTitle(session.actionPrompt, session.actorName)}
						</span>
						<span className="flex shrink-0 items-center gap-1.5">
							<ActorAvatar
								id={session.actorId}
								name={session.actorName}
								type="agent"
								size="sm"
								className="shrink-0"
							/>
							<span className="text-[12px] text-muted-foreground">{session.actorName}</span>
						</span>
					</div>
					<div className="mt-1.5 flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => onViewThread(session.id)}
						>
							View thread
						</Button>
						<span
							className={cn(
								'rounded px-1.5 py-1 font-mono text-[10px] font-bold uppercase leading-none tracking-wider',
								display.className,
							)}
						>
							{display.label}
						</span>
						{elapsed ? (
							<span className="text-[11px] text-muted-foreground">· {elapsed}</span>
						) : null}
					</div>
				</div>
			</div>
		</div>
	)
}
