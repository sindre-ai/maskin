import { trackHandedOffStripRowClicked, trackHandedOffStripShown } from '@/lib/analytics'
import type { SpawnedSession } from '@/lib/api'
import { resolveDepNames, statusToPill } from '@/lib/handed-off-strip'
import { useEffect, useMemo, useRef } from 'react'
import { SubAgentRow } from './sub-agent-row'

interface HandedOffStripProps {
	workspaceId: string
	messageId: number
	spawnedSessions: SpawnedSession[]
}

/**
 * Chat thread `HANDED OFF` sub-agent delegation strip
 * (bet/444b-handed-off-strip). Renders one row per sub-session spawned from
 * an assistant message. Callers must gate on the `handed-off-strip` feature
 * flag AND on the message being an agent message — this component itself
 * only decides whether the strip has anything to say.
 *
 * The strip returns null when no row would be renderable (empty embed, or
 * every session in a v1-out-of-scope status like BLOCKED/STOPPED). Otherwise
 * it fires `handed_off_strip_shown` once per bubble via a mount-time ref so
 * a strip that keeps re-rendering (SSE state ticks) doesn't inflate the
 * impression numerator.
 */
export function HandedOffStrip({ workspaceId, messageId, spawnedSessions }: HandedOffStripProps) {
	// Drop v1-out-of-scope statuses BEFORE the render decision — a strip with
	// only BLOCKED rows must render nothing, not an empty container.
	const visible = useMemo(
		() => spawnedSessions.filter((s) => statusToPill(s.status) !== null),
		[spawnedSessions],
	)

	const shownFiredRef = useRef(false)
	useEffect(() => {
		if (shownFiredRef.current) return
		if (visible.length === 0) return
		shownFiredRef.current = true
		trackHandedOffStripShown({ messageId, subAgentCount: visible.length })
	}, [messageId, visible.length])

	if (visible.length === 0) return null

	return (
		<section
			className="mt-1.5 rounded-lg border border-border bg-card/40 px-2 py-1.5"
			aria-label="Handed off to sub-agents"
		>
			<div className="eyebrow mb-1 flex items-center gap-1 px-1">
				<span>Handed off · {visible.length}</span>
			</div>
			<ul className="flex flex-col gap-0.5">
				{visible.map((session) => {
					return (
						<SubAgentRow
							key={session.id}
							workspaceId={workspaceId}
							session={session}
							depNames={resolveDepNames(session.depends_on_session_ids, spawnedSessions)}
							onClick={() =>
								trackHandedOffStripRowClicked({
									messageId,
									sessionId: session.id,
									subAgentActorId: session.actorId,
									subAgentStatus: session.status,
								})
							}
						/>
					)
				})}
			</ul>
		</section>
	)
}
