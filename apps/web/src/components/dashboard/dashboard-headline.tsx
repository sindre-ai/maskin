import { useDashboardHeadline } from '@/hooks/use-dashboard-headline'
import { useNotifications } from '@/hooks/use-notifications'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'

const RUNNING_SESSION_STATUSES = new Set(['running', 'starting', 'pending'])
const PENDING_NOTIFICATION_STATUSES = new Set(['pending', 'seen'])

// The CTA href is freeform from the LLM (and from the rule-based fallback in
// principle) — if the model is ever prompt-injected, an attacker could place a
// `javascript:` or `data:` URL here that would execute on click. Only allow
// http(s) absolute URLs and same-origin relative paths.
function isSafeCtaHref(href: string): boolean {
	const trimmed = href.trim()
	if (trimmed === '') return false
	if (trimmed.startsWith('/') || trimmed.startsWith('?') || trimmed.startsWith('#')) {
		return !trimmed.startsWith('//')
	}
	return /^https?:\/\//i.test(trimmed)
}

interface PulseDotProps {
	status: 'connected' | 'connecting' | 'disconnected'
}

/**
 * SSE health indicator. Green pulses when live, amber when reconnecting,
 * red when offline. Mirrors the calm-tech principle: never alarm-spam, but
 * make the status legible at a glance.
 */
function PulseDot({ status }: PulseDotProps) {
	const colorClass =
		status === 'connected' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-error'
	const label =
		status === 'connected' ? 'Live' : status === 'connecting' ? 'Reconnecting' : 'Offline'

	return (
		<span
			className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary"
			aria-label={`Connection ${label.toLowerCase()}`}
		>
			<span className="relative flex h-2 w-2">
				{status === 'connected' && (
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
				)}
				<span className={cn('relative inline-flex h-2 w-2 rounded-full', colorClass)} />
			</span>
			<span className="hidden sm:inline">{label}</span>
		</span>
	)
}

/**
 * Top headline strip — the single most important pixel on the dashboard.
 *
 * Always renders four parts: SSE pulse dot · one-sentence narrative · ambient
 * ticker · optional trailing CTA. The narrative falls back synchronously to a
 * deterministic rule-based sentence while the LLM-backed endpoint loads or
 * after a network error, so the strip is *never* a spinner and *never* blank.
 */
export function DashboardHeadline() {
	const { workspaceId, sseStatus } = useWorkspace()

	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const { data: notifications } = useNotifications(workspaceId)
	const { data: tasks } = useObjects(workspaceId, { type: 'task' })

	const runningSessions = useMemo(
		() => (sessions ?? []).filter((s) => RUNNING_SESSION_STATUSES.has(s.status)).length,
		[sessions],
	)

	const pendingNotifications = useMemo(
		() => (notifications ?? []).filter((n) => PENDING_NOTIFICATION_STATUSES.has(n.status)).length,
		[notifications],
	)

	const inProgressTasks = useMemo(
		() => (tasks ?? []).filter((t) => t.status === 'in_progress').length,
		[tasks],
	)

	// Map SSEStatus union onto the three-state pulse dot. `error` and `offline`
	// both map to red; the in-between states map to amber.
	const pulseStatus: PulseDotProps['status'] =
		sseStatus === 'connected'
			? 'connected'
			: sseStatus === 'connecting'
				? 'connecting'
				: 'disconnected'

	const { headline } = useDashboardHeadline(workspaceId, {
		runningSessions,
		pendingNotifications,
		eventsLast24h: 0,
		uniqueAgentsLast24h: 0,
	})

	const tickerParts = [
		`${runningSessions} agent${runningSessions === 1 ? '' : 's'} working`,
		`${inProgressTasks} task${inProgressTasks === 1 ? '' : 's'} in progress`,
		`${pendingNotifications} decision${pendingNotifications === 1 ? '' : 's'} waiting`,
	]

	return (
		<div className="flex w-full flex-col gap-3 rounded-lg border border-border bg-bg-surface px-5 py-4 shadow-sm md:flex-row md:items-center md:gap-5">
			<PulseDot status={pulseStatus} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="font-medium text-base text-text leading-snug md:text-lg">
					{headline.headline}
					{headline.cta && isSafeCtaHref(headline.cta.href) ? (
						<>
							{' '}
							<a
								href={headline.cta.href}
								className="inline-flex items-center gap-0.5 text-accent hover:text-accent-hover hover:underline"
							>
								{headline.cta.text}
								<ArrowRight className="inline" size={14} />
							</a>
						</>
					) : null}
				</p>
				<p className="text-text-secondary text-xs">{tickerParts.join(' · ')}</p>
			</div>
		</div>
	)
}
