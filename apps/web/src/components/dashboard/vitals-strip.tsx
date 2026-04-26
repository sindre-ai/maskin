import type { AgentStatus } from '@/components/agents/agent-card'
import { useActors } from '@/hooks/use-actors'
import { useNotifications } from '@/hooks/use-notifications'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { deriveAgentStatus, groupSessionsByAgent } from '@/lib/agent-status'
import type { NotificationResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { MiniBarChart } from './mini-bar-chart'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const SOFT_CAP_PER_AGENT_PER_DAY = 20
const FALLBACK_DAILY_CAP = 50

const BURN_RATE_BUCKETS = 6
const BURN_RATE_BUCKET_MS = (60 * 60 * 1000) / BURN_RATE_BUCKETS

export interface VitalsStripProps {
	workspaceId: string
	className?: string
	/** Hook for the wall-clock — defaults to Date.now. Injectable for tests. */
	now?: () => number
}

export function VitalsStrip({ workspaceId, className, now = Date.now }: VitalsStripProps) {
	const { data: agents = [] } = useActors(workspaceId, { enabled: !!workspaceId })
	const { data: sessions = [] } = useWorkspaceSessions(workspaceId)
	const { data: pendingDecisions = [] } = useNotifications(workspaceId, {
		status: 'pending,seen',
	})
	const { data: resolvedDecisions = [] } = useNotifications(workspaceId, {
		status: 'resolved',
	})

	const nowMs = now()

	const sessionsByAgent = groupSessionsByAgent(sessions)
	const agentStatusCounts = countAgentStatuses(
		agents.map((a) => a.id),
		sessionsByAgent,
	)

	const sessionsLast24h = sessionsWithin(sessions, nowMs, DAY_MS)
	const dailyCap = Math.max(FALLBACK_DAILY_CAP, agents.length * SOFT_CAP_PER_AGENT_PER_DAY)
	const costRatio = clamp01(sessionsLast24h.length / dailyCap)

	const decisionsLastHourBuckets = bucketDecisionsPerInterval(
		resolvedDecisions,
		nowMs,
		BURN_RATE_BUCKETS,
		BURN_RATE_BUCKET_MS,
	)
	const decisionsPerHour = decisionsLastHourBuckets.reduce((sum, n) => sum + n, 0)

	return (
		<div
			className={cn(
				'flex w-full flex-wrap items-stretch gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-md',
				className,
			)}
			aria-label="Workspace vitals"
		>
			<CostRingCell ratio={costRatio} sessionCount={sessionsLast24h.length} cap={dailyCap} />

			<AgentMixCell
				working={agentStatusCounts.working}
				idle={agentStatusCounts.idle}
				blocked={agentStatusCounts.failed}
			/>

			<MetricCell label="Pending decisions" value={pendingDecisions.length} />

			<DecisionsPerHourCell value={decisionsPerHour} buckets={decisionsLastHourBuckets} />
		</div>
	)
}

interface CostRingCellProps {
	ratio: number
	sessionCount: number
	cap: number
}

function CostRingCell({ ratio, sessionCount, cap }: CostRingCellProps) {
	const radius = 14
	const circumference = 2 * Math.PI * radius
	const dashOffset = circumference * (1 - ratio)
	const tone = ratio >= 1 ? 'text-warning' : ratio >= 0.8 ? 'text-warning' : 'text-accent'

	return (
		<div
			className="flex min-w-[10rem] flex-1 items-center gap-3"
			title={`${sessionCount} sessions today / soft cap ${cap}`}
		>
			<svg
				width={36}
				height={36}
				viewBox="0 0 36 36"
				role="img"
				aria-label={`Cost usage ${Math.round(ratio * 100)} percent`}
			>
				<circle
					cx={18}
					cy={18}
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeWidth={3}
					className="text-muted"
				/>
				<circle
					cx={18}
					cy={18}
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeWidth={3}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					transform="rotate(-90 18 18)"
					className={tone}
				/>
			</svg>
			<div className="flex flex-col">
				<span className="text-xs text-muted-foreground">Cost</span>
				<span className="text-sm font-medium text-foreground">{Math.round(ratio * 100)}%</span>
			</div>
		</div>
	)
}

interface AgentMixCellProps {
	working: number
	idle: number
	blocked: number
}

function AgentMixCell({ working, idle, blocked }: AgentMixCellProps) {
	const total = working + idle + blocked
	const segments = [
		{ value: working, color: 'var(--color-accent)', label: 'working' },
		{ value: idle, color: 'var(--color-muted-foreground)', label: 'idle' },
		{ value: blocked, color: 'var(--color-error)', label: 'blocked' },
	].filter((s) => s.value > 0)

	return (
		<div className="flex min-w-[12rem] flex-1 items-center gap-3">
			<div className="flex h-9 w-9 items-end">
				<MiniBarChart
					data={[
						{
							label: 'agents',
							segments:
								segments.length > 0
									? segments
									: [{ value: 1, color: 'var(--color-muted-foreground)' }],
						},
					]}
					height={36}
					ariaLabel="Agent status mix"
				/>
			</div>
			<div className="flex flex-col">
				<span className="text-xs text-muted-foreground">Agents</span>
				<span className="text-sm font-medium text-foreground">
					<span className="text-status-in_progress-text">{working}</span>
					<span className="text-muted-foreground"> · </span>
					<span>{idle}</span>
					<span className="text-muted-foreground"> · </span>
					<span className={cn(blocked > 0 && 'text-error')}>{blocked}</span>
				</span>
				<span className="text-[10px] text-muted-foreground">
					working · idle · blocked ({total})
				</span>
			</div>
		</div>
	)
}

interface MetricCellProps {
	label: string
	value: number | string
}

function MetricCell({ label, value }: MetricCellProps) {
	return (
		<div className="flex min-w-[8rem] flex-1 flex-col justify-center">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-lg font-medium text-foreground">{value}</span>
		</div>
	)
}

interface DecisionsPerHourCellProps {
	value: number
	buckets: number[]
}

function DecisionsPerHourCell({ value, buckets }: DecisionsPerHourCellProps) {
	return (
		<div className="flex min-w-[10rem] flex-1 items-center gap-3">
			<MiniBarChart
				className="w-16"
				data={buckets.map((n, i) => ({ label: `bucket ${i + 1}`, value: n }))}
				height={36}
				ariaLabel="Decisions per hour burn rate"
			/>
			<div className="flex flex-col">
				<span className="text-xs text-muted-foreground">Decisions / hr</span>
				<span className="text-lg font-medium text-foreground">{value}</span>
			</div>
		</div>
	)
}

interface AgentStatusCounts {
	working: number
	idle: number
	failed: number
}

export function countAgentStatuses(
	agentIds: string[],
	sessionsByAgent: Map<string, { actorId: string; status: string; createdAt: string | null }[]>,
): AgentStatusCounts {
	const counts: AgentStatusCounts = { working: 0, idle: 0, failed: 0 }
	for (const id of agentIds) {
		const status: AgentStatus = deriveAgentStatus(id, sessionsByAgent)
		counts[status] += 1
	}
	return counts
}

export function sessionsWithin(
	sessions: SessionResponse[],
	nowMs: number,
	windowMs: number,
): SessionResponse[] {
	const cutoff = nowMs - windowMs
	return sessions.filter((s) => {
		if (!s.createdAt) return false
		const t = Date.parse(s.createdAt)
		return Number.isFinite(t) && t >= cutoff
	})
}

export function bucketDecisionsPerInterval(
	resolved: NotificationResponse[],
	nowMs: number,
	bucketCount: number,
	bucketMs: number,
): number[] {
	const buckets = new Array(bucketCount).fill(0) as number[]
	const windowStart = nowMs - bucketCount * bucketMs
	for (const n of resolved) {
		if (!n.resolvedAt) continue
		const t = Date.parse(n.resolvedAt)
		if (!Number.isFinite(t) || t < windowStart || t > nowMs) continue
		const idx = Math.min(bucketCount - 1, Math.floor((t - windowStart) / bucketMs))
		buckets[idx] += 1
	}
	return buckets
}

function clamp01(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 0
	if (n >= 1) return 1
	return n
}
