import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { Spinner } from '@/components/ui/spinner'
import { useActors } from '@/hooks/use-actors'
import { useCreateSession, useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, getLatestSession, groupSessionsByAgent } from '@/lib/agent-status'
import type { ActorListItem, ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Pause, RotateCw } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'

type RosterStatus = 'working' | 'idle' | 'failed'

const BUDGET_WARN_THRESHOLD = 0.8
const SESSIONS_PER_DAY_SOFT_CAP = 20

export function TeamRoster() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading: actorsLoading } = useActors(workspaceId)
	const { data: sessions, isLoading: sessionsLoading } = useWorkspaceSessions(workspaceId)
	const createSession = useCreateSession(workspaceId)

	const agents = useMemo(
		() => (actors ?? []).filter((a) => a.type === 'agent'),
		[actors],
	) as ActorListItem[]

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions ?? []), [sessions])
	const budgetByAgent = useMemo(() => computeBudgetUsedByAgent(sessions ?? []), [sessions])

	if (actorsLoading || sessionsLoading) {
		return (
			<RosterGrid>
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</RosterGrid>
		)
	}

	if (agents.length === 0) {
		return (
			<EmptyState
				title="No agents on the team yet"
				description="Add an agent to see them on the roster."
			/>
		)
	}

	const retryingAgentId = createSession.isPending ? createSession.variables?.actor_id : undefined

	return (
		<RosterGrid>
			{agents.map((agent) => {
				const status = deriveAgentStatus(agent.id, sessionsByAgent)
				const latestSession = getLatestSession(agent.id, sessionsByAgent) as
					| SessionResponse
					| undefined
				return (
					<RosterCard
						key={agent.id}
						agent={agent as ActorResponse}
						status={status}
						latestSession={latestSession}
						budgetUsed={budgetByAgent.get(agent.id) ?? 0}
						workspaceId={workspaceId}
						onRetry={(actionPrompt) =>
							createSession.mutate({ actor_id: agent.id, action_prompt: actionPrompt })
						}
						isRetrying={retryingAgentId === agent.id}
					/>
				)
			})}
		</RosterGrid>
	)
}

function RosterGrid({ children }: { children: ReactNode }) {
	return (
		<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{children}
		</div>
	)
}

function RosterCard({
	agent,
	status,
	latestSession,
	budgetUsed,
	workspaceId,
	onRetry,
	isRetrying,
}: {
	agent: ActorResponse
	status: RosterStatus
	latestSession?: SessionResponse
	budgetUsed: number
	workspaceId: string
	onRetry: (actionPrompt: string) => void
	isRetrying: boolean
}) {
	const role = agent.systemPrompt?.split('\n')[0]?.trim()
	const focus = describeFocus(status, latestSession)
	const lastActiveAt = latestSession?.completedAt ?? latestSession?.startedAt ?? null

	return (
		<Link
			to="/$workspaceId/agents/$agentId"
			params={{ workspaceId, agentId: agent.id }}
			className={cn(
				'group flex flex-col items-center gap-3 rounded-lg border bg-card p-5 text-center shadow-md transition-colors hover:border-border-hover',
				status === 'working' && 'border-accent/60',
				status === 'failed' && 'border-error',
				status === 'idle' && 'border-border',
			)}
		>
			<AvatarPortrait name={agent.name} type={agent.type} status={status} budgetUsed={budgetUsed} />

			<div className="flex flex-col items-center gap-0.5 min-w-0 w-full">
				<span className="text-sm font-semibold text-foreground truncate max-w-full">
					{agent.name}
				</span>
				{role && (
					<span className="text-xs text-muted-foreground line-clamp-1 max-w-full">{role}</span>
				)}
			</div>

			<FocusLine status={status} text={focus} />

			<div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-auto">
				<StatusPill status={status} />
				{lastActiveAt && <RelativeTime date={lastActiveAt} />}
			</div>

			{status === 'failed' && latestSession && (
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						onRetry(latestSession.actionPrompt)
					}}
					disabled={isRetrying}
					className={cn(
						'inline-flex items-center justify-center gap-1.5 rounded-md border border-error/40 bg-error/10 px-3 py-1.5 text-xs font-medium text-error transition-colors',
						'hover:bg-error/15 disabled:opacity-60 disabled:cursor-not-allowed',
						'min-h-[36px] w-full',
					)}
				>
					<RotateCw size={12} />
					{isRetrying ? 'Retrying…' : 'Retry session'}
				</button>
			)}
		</Link>
	)
}

function FocusLine({ status, text }: { status: RosterStatus; text: string }) {
	// Working text uses the same high-contrast `text-foreground` as idle so the
	// focus sentence is always legible — fixes insight 1a672b81 (working state
	// text was previously light grey and unreadable).
	return (
		<p
			className={cn(
				'text-xs leading-snug line-clamp-2 w-full min-h-8',
				status === 'failed' ? 'text-error' : 'text-foreground',
			)}
		>
			{text}
		</p>
	)
}

function StatusPill({ status }: { status: RosterStatus }) {
	const meta = STATUS_META[status]
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
				meta.pillBg,
				meta.pillText,
			)}
		>
			{status === 'working' ? (
				<Spinner className="size-3" />
			) : (
				<meta.Icon className="size-3" aria-hidden="true" />
			)}
			{meta.label}
		</span>
	)
}

function AvatarPortrait({
	name,
	type,
	status,
	budgetUsed,
}: {
	name: string
	type: string
	status: RosterStatus
	budgetUsed: number
}) {
	const size = 64
	const stroke = 3
	const radius = (size - stroke) / 2
	const circumference = 2 * Math.PI * radius
	const clamped = Math.min(1, Math.max(0, budgetUsed))
	const dashOffset = circumference * (1 - clamped)
	const overBudget = clamped >= 1
	const warning = clamped >= BUDGET_WARN_THRESHOLD

	const ringColor =
		status === 'failed' ? 'stroke-error' : status === 'working' ? 'stroke-accent' : 'stroke-border'

	const budgetColor = overBudget
		? 'stroke-error'
		: warning
			? 'stroke-warning'
			: 'stroke-muted-foreground/50'

	const meta = STATUS_META[status]

	return (
		<div className="relative" style={{ width: size, height: size }}>
			<svg
				className="absolute inset-0 -rotate-90"
				width={size}
				height={size}
				role="presentation"
				aria-hidden="true"
			>
				<title>Agent status ring</title>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					strokeWidth={stroke}
					className={cn(
						ringColor,
						status === 'working' && 'animate-[spin_3s_linear_infinite] origin-center',
					)}
					strokeDasharray={status === 'working' ? '6 4' : undefined}
				/>
				{clamped > 0 && (
					<circle
						cx={size / 2}
						cy={size / 2}
						r={radius - stroke - 1}
						fill="none"
						strokeWidth={1.5}
						className={budgetColor}
						strokeDasharray={circumference}
						strokeDashoffset={dashOffset}
						strokeLinecap="round"
					/>
				)}
			</svg>
			<div className="absolute inset-0 flex items-center justify-center">
				<ActorAvatar name={name} type={type} size="md" className="h-12 w-12 text-base" />
			</div>
			<span
				className={cn(
					'absolute -bottom-1 -right-1 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-card',
					meta.badgeBg,
					meta.badgeText,
				)}
				aria-label={`Status: ${meta.label}`}
				title={meta.label}
			>
				{status === 'working' ? (
					<Spinner className="size-2.5" />
				) : overBudget ? (
					<Pause className="size-2.5" aria-hidden="true" />
				) : (
					<meta.Icon className="size-2.5" aria-hidden="true" />
				)}
			</span>
		</div>
	)
}

function describeFocus(status: RosterStatus, session?: SessionResponse): string {
	if (!session) {
		return status === 'working' ? 'Spinning up…' : 'Resting — no recent missions'
	}
	const prompt = session.actionPrompt?.trim() || 'Untitled session'
	if (status === 'failed') return `Failed: ${prompt}`
	return prompt
}

export function computeBudgetUsedByAgent(
	sessions: Array<{ actorId: string; createdAt: string | null }>,
): Map<string, number> {
	const cutoff = Date.now() - 24 * 60 * 60 * 1000
	const counts = new Map<string, number>()
	for (const s of sessions) {
		if (!s.createdAt) continue
		const t = new Date(s.createdAt).getTime()
		if (Number.isFinite(t) && t >= cutoff) {
			counts.set(s.actorId, (counts.get(s.actorId) ?? 0) + 1)
		}
	}
	const out = new Map<string, number>()
	for (const [actorId, count] of counts) {
		out.set(actorId, count / SESSIONS_PER_DAY_SOFT_CAP)
	}
	return out
}

interface StatusMeta {
	label: string
	Icon: typeof AlertTriangle
	pillBg: string
	pillText: string
	badgeBg: string
	badgeText: string
}

const STATUS_META: Record<RosterStatus, StatusMeta> = {
	working: {
		label: 'Working',
		Icon: AlertTriangle, // not rendered for working — Spinner is used directly
		pillBg: 'bg-status-in_progress-bg',
		pillText: 'text-status-in_progress-text',
		badgeBg: 'bg-status-in_progress-bg',
		badgeText: 'text-status-in_progress-text',
	},
	idle: {
		label: 'Idle',
		Icon: Pause,
		pillBg: 'bg-muted',
		pillText: 'text-muted-foreground',
		badgeBg: 'bg-muted',
		badgeText: 'text-muted-foreground',
	},
	failed: {
		label: 'Failed',
		Icon: AlertTriangle,
		pillBg: 'bg-status-failed-bg',
		pillText: 'text-status-failed-text',
		badgeBg: 'bg-status-failed-bg',
		badgeText: 'text-status-failed-text',
	},
}
