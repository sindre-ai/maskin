import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useDuration } from '@/hooks/use-duration'
import type { SpawnedSession } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationMs } from '@/lib/format-duration'
import {
	STRIP_PILL_CLASSES,
	failureText,
	formatDepNames,
	statusToPill,
} from '@/lib/handed-off-strip'
import type { StripPill } from '@/lib/handed-off-strip'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

interface SubAgentRowProps {
	workspaceId: string
	session: SpawnedSession
	/** Names of the sessions this row is behind, already resolved within the strip. */
	depNames: readonly string[]
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
export function SubAgentRow({ workspaceId, session, depNames, onClick }: SubAgentRowProps) {
	const pill = statusToPill(session.status)
	// The row owns both dep forms: full names for desktop + the hover tooltip,
	// the count for the mobile rule (`· behind 2`). Deriving them here keeps one
	// source of truth, so the tooltip can never disagree with the visible text.
	const depClause = depNames.length > 0 ? formatDepNames(depNames) : null
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

	const clauseClass = 'text-[11px] text-muted-foreground'

	return (
		<li>
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: session.actorId }}
				search={{ session: session.id } as never}
				onClick={onClick}
				className={cn(
					'flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors max-md:min-h-11',
					'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
					flash && 'bg-brand/10',
				)}
				aria-label={`Sub-agent ${session.actorName}: ${pill}`}
			>
				<ActorAvatar
					id={session.actorId}
					name={session.actorName}
					type="agent"
					size="sm"
					className="shrink-0"
				/>
				<div className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-semibold text-foreground">
						{session.actorName}
					</span>
					<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
						<span className="min-w-0 truncate">{session.actionPrompt}</span>
						{depClause ? (
							<>
								{/* Desktop: full names. Phones truncate the list to a bare count, swapped
								    at the same `md:` boundary as the rest of the chat. */}
								<span className={cn(clauseClass, 'hidden md:inline')} title={depClause}>
									· after {depClause}
								</span>
								<span className={cn(clauseClass, 'md:hidden')} title={depClause}>
									· after {depNames.length}
								</span>
							</>
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
				</div>
				{/* The text stays upper case for the tests and screen readers; it reads "Working". */}
				<span
					className={cn(
						'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold leading-none lowercase first-letter:uppercase',
						STRIP_PILL_CLASSES[pill],
						flash && 'ring-2 ring-brand',
					)}
				>
					{pill}
				</span>
			</Link>
		</li>
	)
}
