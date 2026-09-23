import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useDuration } from '@/hooks/use-duration'
import type { SpawnedSession } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationMs } from '@/lib/format-duration'
import { failureText, statusToPill } from '@/lib/handed-off-strip'
import type { StripPill } from '@/lib/handed-off-strip'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

interface SubAgentRowProps {
	workspaceId: string
	session: SpawnedSession
	/** Comma-and-joined names of the sessions this row is behind, or empty. */
	depClause: string | null
	onClick: () => void
}

/**
 * One row in the delegation strip: avatar + agent name + action prompt + pill
 * + optional deps clause / elapsed / current activity / failure text.
 *
 * The pill transition WORKING → DONE fires a 900ms `--brand` flash on the row
 * so a reader who is looking at the strip sees the completion land instead of
 * having to compare screenshots. Rows never reorder — the flash is the only
 * motion, per the design spec's Interaction details.
 */
export function SubAgentRow({ workspaceId, session, depClause, onClick }: SubAgentRowProps) {
	const pill = statusToPill(session.status)
	const previousPillRef = useRef<StripPill | null>(pill)
	const [flash, setFlash] = useState(false)
	// Live elapsed for a running row. `useDuration` re-renders every 30s, so the
	// count-up ticks in place without polling the API.
	const elapsedRunning = useDuration(pill === 'WORKING' ? session.startedAt : null)
	// A completed row shows its final total instead — `useDuration` on a null
	// input is a no-op, so we compute the completed total directly.
	const elapsedCompleted =
		pill === 'DONE' && typeof session.durationMs === 'number' && session.durationMs > 0
			? formatDurationMs(session.durationMs)
			: null

	useEffect(() => {
		const previous = previousPillRef.current
		previousPillRef.current = pill
		if (previous === 'WORKING' && pill === 'DONE') {
			setFlash(true)
			const t = setTimeout(() => setFlash(false), 900)
			return () => clearTimeout(t)
		}
	}, [pill])

	if (!pill) return null

	const pillClasses: Record<StripPill, string> = {
		QUEUED: 'bg-[var(--st-todo-bg)] text-[var(--st-todo-text)]',
		WORKING: 'bg-[var(--st-in_progress-bg)] text-[var(--st-in_progress-text)]',
		DONE: 'bg-[var(--st-active-bg)] text-[var(--st-active-text)]',
		FAILED: 'bg-destructive/10 text-destructive',
	}

	const clauseClass = 'text-[11px] text-muted-foreground'

	return (
		<li>
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: session.actorId }}
				search={{ session: session.id } as never}
				onClick={onClick}
				className={cn(
					'flex flex-col items-start gap-1 rounded-md px-2 py-1.5 transition-colors md:flex-row md:items-center md:gap-2',
					'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
					flash && 'bg-brand/10',
				)}
				aria-label={`Sub-agent ${session.actorName}: ${pill}`}
			>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<ActorAvatar
						id={session.actorId}
						name={session.actorName}
						type="agent"
						size="sm"
						className="shrink-0"
					/>
					<span className="shrink-0 text-[12.5px] font-semibold text-foreground">
						{session.actorName}
					</span>
					<span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
						{session.actionPrompt}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span
						className={cn(
							'font-mono text-[10px] font-bold uppercase tracking-wider leading-none rounded px-1.5 py-1',
							pillClasses[pill],
							flash && 'ring-2 ring-brand',
						)}
					>
						{pill}
					</span>
					{pill === 'WORKING' ? (
						<span
							className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand"
							aria-hidden
						/>
					) : null}
					{depClause ? (
						<span className={clauseClass} title={depClause}>
							· behind {depClause}
						</span>
					) : null}
					{pill === 'WORKING' && elapsedRunning ? (
						<span className={clauseClass}>· {elapsedRunning}</span>
					) : null}
					{pill === 'DONE' && elapsedCompleted ? (
						<span className={clauseClass}>· {elapsedCompleted}</span>
					) : null}
					{pill === 'WORKING' && session.currentActivity ? (
						<span className={clauseClass}>· {session.currentActivity}</span>
					) : null}
					{pill === 'FAILED' ? (
						<span className="text-[11px] text-destructive">· {failureText(session.result)}</span>
					) : null}
				</div>
			</Link>
		</li>
	)
}
