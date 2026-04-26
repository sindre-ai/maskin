import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSessionLatestLog, useWorkspaceSessions } from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import type { SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useEffect, useMemo, useState } from 'react'

const RUNNING_SESSION_STATUSES = new Set(['running', 'starting', 'pending'])
const ROTATE_INTERVAL_MS = 8000
const TYPEWRITER_STEP_MS = 25
const TYPEWRITER_CHARS_PER_STEP = 2
const RIBBON_MAX_CHARS = 140

/**
 * Cinematic hero card showing the single most-active running session.
 *
 * Communicates *motion*, not metrics — the card is the eye-catcher of the
 * Bridge dashboard. Tesla HUD rule: shape and color over numbers; animation
 * is always informational (typewriter ribbon = real log progress, dot
 * indicators = real session count), never gratuitous.
 *
 * - Picks the most-recently-active running session by `updatedAt`/`startedAt`.
 * - Multiple sessions auto-rotate every ~8s with dot indicators; pause on hover.
 * - Empty state surfaces the next scheduled trigger or a calm "Team at rest".
 */
export function NowHappeningHero() {
	const { workspaceId } = useWorkspace()
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const { data: triggers } = useTriggers(workspaceId)

	const runningSessions = useMemo(() => {
		const list = (sessions ?? []).filter((s) => RUNNING_SESSION_STATUSES.has(s.status))
		return list.sort(
			(a, b) =>
				new Date(b.updatedAt ?? b.startedAt ?? 0).getTime() -
				new Date(a.updatedAt ?? a.startedAt ?? 0).getTime(),
		)
	}, [sessions])

	const [activeIndex, setActiveIndex] = useState(0)
	const [paused, setPaused] = useState(false)

	// Clamp index when the running list shrinks (e.g. a session completes).
	useEffect(() => {
		if (runningSessions.length === 0) {
			if (activeIndex !== 0) setActiveIndex(0)
			return
		}
		if (activeIndex >= runningSessions.length) {
			setActiveIndex(0)
		}
	}, [runningSessions.length, activeIndex])

	useEffect(() => {
		if (runningSessions.length <= 1 || paused) return
		const interval = setInterval(() => {
			setActiveIndex((i) => (i + 1) % runningSessions.length)
		}, ROTATE_INTERVAL_MS)
		return () => clearInterval(interval)
	}, [runningSessions.length, paused])

	if (runningSessions.length === 0) {
		const nextTrigger = pickNextScheduledTrigger(triggers ?? [])
		return <RestingHero nextTriggerName={nextTrigger?.name ?? null} />
	}

	const activeSession = runningSessions[activeIndex] ?? runningSessions[0]

	return (
		<section
			aria-label="Now happening"
			className="relative flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-bg-surface p-6 shadow-sm md:p-8"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<ActiveSessionPanel
				key={activeSession.id}
				session={activeSession}
				workspaceId={workspaceId}
			/>
			{runningSessions.length > 1 && (
				<DotIndicators
					sessionIds={runningSessions.map((s) => s.id)}
					active={activeIndex}
					onSelect={setActiveIndex}
				/>
			)}
		</section>
	)
}

function ActiveSessionPanel({
	session,
	workspaceId,
}: {
	session: SessionResponse
	workspaceId: string
}) {
	const { data: actor } = useActor(session.actorId)
	const { data: latestLog } = useSessionLatestLog(session.id, workspaceId)
	const duration = useDuration(session.startedAt)

	const ribbonText = (latestLog?.content ?? '').slice(0, RIBBON_MAX_CHARS)
	const ribbonKey = latestLog?.id ?? 'awaiting'

	return (
		<div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-6">
			<div className="shrink-0">
				<ActorAvatar
					name={actor?.name ?? 'Agent'}
					type={actor?.type ?? 'agent'}
					className="h-16 w-16 text-2xl ring-2 ring-primary/30"
				/>
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
						Now happening
					</span>
					<span className="text-xs text-text-secondary">
						{actor?.name ?? 'An agent'}
						{duration ? ` · ${duration}` : ''}
					</span>
				</div>
				<h2 className="text-balance font-semibold text-lg text-text leading-snug md:text-xl">
					{session.actionPrompt || 'Untitled session'}
				</h2>
				<TypewriterRibbon key={ribbonKey} text={ribbonText} />
			</div>
		</div>
	)
}

/**
 * Reveals `text` character-by-character so the latest log line reads as a
 * teletype crawl. Resets whenever a new log arrives (parent re-keys on
 * `latestLog.id`). Cleans up its interval on unmount and on text change so
 * we never leak timers across rotations.
 */
function TypewriterRibbon({ text }: { text: string }) {
	const [revealed, setRevealed] = useState(0)

	useEffect(() => {
		setRevealed(0)
		if (!text) return
		const interval = setInterval(() => {
			setRevealed((r) => {
				const next = r + TYPEWRITER_CHARS_PER_STEP
				if (next >= text.length) {
					clearInterval(interval)
					return text.length
				}
				return next
			})
		}, TYPEWRITER_STEP_MS)
		return () => clearInterval(interval)
	}, [text])

	if (!text) {
		return <p className="text-sm text-text-secondary italic">Awaiting first log line…</p>
	}

	const isTyping = revealed < text.length
	return (
		<p
			className="font-mono text-sm text-text-secondary leading-relaxed"
			aria-label={text}
			aria-live="polite"
		>
			{text.slice(0, revealed)}
			<span
				className={cn(
					'ml-0.5 inline-block w-1.5 h-3.5 align-middle bg-primary/70',
					isTyping ? 'animate-pulse' : 'opacity-0',
				)}
				aria-hidden="true"
			/>
		</p>
	)
}

function DotIndicators({
	sessionIds,
	active,
	onSelect,
}: {
	sessionIds: string[]
	active: number
	onSelect: (index: number) => void
}) {
	return (
		<div className="flex items-center gap-1.5" role="tablist" aria-label="Running sessions">
			{sessionIds.map((id, i) => (
				<button
					key={id}
					type="button"
					role="tab"
					aria-selected={i === active}
					aria-label={`Show session ${i + 1} of ${sessionIds.length}`}
					onClick={() => onSelect(i)}
					className={cn(
						'h-1.5 rounded-full transition-all duration-300',
						i === active ? 'w-6 bg-primary' : 'w-1.5 bg-text-muted/40 hover:bg-text-muted/70',
					)}
				/>
			))}
		</div>
	)
}

function RestingHero({ nextTriggerName }: { nextTriggerName: string | null }) {
	return (
		<section
			aria-label="Now happening"
			className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border border-dashed bg-bg-surface px-6 py-12 text-center"
		>
			<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
				Now happening
			</span>
			<p className="font-medium text-base text-text md:text-lg">
				{nextTriggerName ? `Up next: ${nextTriggerName}` : 'Team at rest.'}
			</p>
			<p className="text-text-secondary text-xs">
				{nextTriggerName
					? 'A scheduled trigger will pick things up.'
					: 'Nothing is running right now.'}
			</p>
		</section>
	)
}

interface TriggerLike {
	name: string
	type: string
	enabled: boolean
}

/**
 * Picks a representative "next scheduled" trigger for the empty state.
 *
 * We don't have a cron parser available, so this surfaces the first enabled
 * cron trigger by name rather than a precise next-fire time — consistent with
 * the Tesla HUD rule of communicating presence over precision when the latter
 * would require new dependencies.
 */
export function pickNextScheduledTrigger<T extends TriggerLike>(triggers: T[]): T | null {
	for (const t of triggers) {
		if (t.enabled && t.type === 'cron') return t
	}
	return null
}
