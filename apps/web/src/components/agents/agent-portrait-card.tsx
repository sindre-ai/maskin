import { useDuration } from '@/hooks/use-duration'
import type { ActorResponse, AgentState, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Pause, Play } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'

export type PortraitStatus = 'running' | 'paused' | 'idle' | 'failed'

export function AgentPortraitCard({
	agent,
	status,
	latestSession,
	onRun,
	onPause,
	isRunPending = false,
	isPausePending = false,
}: {
	agent: ActorResponse
	status: PortraitStatus
	latestSession?: SessionResponse
	onRun: () => void
	onPause: () => void
	isRunPending?: boolean
	isPausePending?: boolean
}) {
	const { workspaceId } = useWorkspace()
	const role = agent.system_prompt?.split('\n')[0]?.trim()
	const focus = describeFocus(status, latestSession)

	const meta = STATUS_META[status]
	const isRunning = status === 'running'

	return (
		<div
			className={cn(
				'group relative flex flex-col items-center gap-3 rounded-lg border bg-card p-5 text-center shadow-md transition-colors',
				isRunning && 'border-accent/60',
				status === 'failed' && 'border-error',
				status === 'paused' && 'border-border',
				status === 'idle' && 'border-border hover:border-border-hover',
			)}
		>
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: agent.id }}
				className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={`Open ${agent.name}`}
			/>

			<AvatarPortrait name={agent.name} type={agent.type} status={status} />

			<div className="relative flex flex-col items-center gap-0.5 min-w-0 w-full pointer-events-none">
				<span className="text-sm font-semibold text-foreground truncate max-w-full">
					{agent.name}
				</span>
				{role && (
					<span className="text-xs text-muted-foreground line-clamp-1 max-w-full">{role}</span>
				)}
			</div>

			<FocusLine status={status} text={focus} session={latestSession} />

			<div className="relative inline-flex items-center gap-1.5 text-[11px] text-muted-foreground pointer-events-none">
				<span
					className={cn(
						'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
						meta.pillBg,
						meta.pillText,
					)}
				>
					{isRunning ? (
						<Spinner className="size-3" aria-hidden="true" />
					) : (
						<meta.Icon className="size-3" aria-hidden="true" />
					)}
					{meta.label}
				</span>
			</div>

			<div className="relative mt-auto flex w-full items-center justify-center gap-2 pt-1">
				{isRunning ? (
					<PortraitButton
						intent="pause"
						onClick={onPause}
						disabled={isPausePending}
						label={isPausePending ? 'Pausing…' : 'Pause'}
					/>
				) : (
					<PortraitButton
						intent="run"
						onClick={onRun}
						disabled={isRunPending}
						label={isRunPending ? 'Starting…' : status === 'paused' ? 'Resume' : 'Run'}
					/>
				)}
			</div>
		</div>
	)
}

function PortraitButton({
	intent,
	onClick,
	disabled,
	label,
}: {
	intent: 'run' | 'pause'
	onClick: () => void
	disabled: boolean
	label: string
}) {
	const Icon = intent === 'run' ? Play : Pause
	return (
		<Button
			type="button"
			size="sm"
			variant={intent === 'run' ? 'default' : 'outline'}
			onClick={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onClick()
			}}
			disabled={disabled}
			className="w-full min-h-[44px]"
		>
			<Icon size={14} aria-hidden="true" />
			{label}
		</Button>
	)
}

function FocusLine({
	status,
	text,
	session,
}: {
	status: PortraitStatus
	text: string
	session?: SessionResponse
}) {
	return (
		<p
			className={cn(
				'relative text-xs leading-snug line-clamp-2 w-full min-h-8 pointer-events-none',
				status === 'failed' ? 'text-error' : 'text-foreground',
			)}
		>
			{text}
			{status === 'running' && session?.startedAt && (
				<RunningDuration startedAt={session.startedAt} />
			)}
		</p>
	)
}

function RunningDuration({ startedAt }: { startedAt: string }) {
	const duration = useDuration(startedAt)
	if (!duration) return null
	return <span className="text-muted-foreground"> · {duration}</span>
}

function AvatarPortrait({
	name,
	type,
	status,
}: {
	name: string
	type: string
	status: PortraitStatus
}) {
	const size = 64
	const stroke = 3
	const radius = (size - stroke) / 2

	const ringColor =
		status === 'failed'
			? 'stroke-error'
			: status === 'running'
				? 'stroke-accent'
				: status === 'paused'
					? 'stroke-muted-foreground/60'
					: 'stroke-border'

	return (
		<div className="relative pointer-events-none" style={{ width: size, height: size }}>
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
						status === 'running' && 'animate-[spin_3s_linear_infinite] origin-center',
					)}
					strokeDasharray={status === 'running' ? '6 4' : undefined}
				/>
			</svg>
			<div className="absolute inset-0 flex items-center justify-center">
				<ActorAvatar name={name} type={type} size="md" className="h-12 w-12 text-base" />
			</div>
		</div>
	)
}

function describeFocus(status: PortraitStatus, session?: SessionResponse): string {
	if (status === 'failed') {
		return session?.actionPrompt ? `Failed: ${session.actionPrompt}` : 'Last run failed'
	}
	if (status === 'running') {
		return session?.actionPrompt ?? 'Working…'
	}
	if (status === 'paused') {
		return 'Paused — ready when you are'
	}
	if (session?.actionPrompt) {
		return session.actionPrompt
	}
	return 'Standing by'
}

interface StatusMeta {
	label: string
	Icon: typeof Pause
	pillBg: string
	pillText: string
}

const STATUS_META: Record<PortraitStatus, StatusMeta> = {
	running: {
		label: 'Running',
		Icon: Play,
		pillBg: 'bg-status-in_progress-bg',
		pillText: 'text-status-in_progress-text',
	},
	paused: {
		label: 'Paused',
		Icon: Pause,
		pillBg: 'bg-muted',
		pillText: 'text-muted-foreground',
	},
	idle: {
		label: 'Idle',
		Icon: Pause,
		pillBg: 'bg-muted',
		pillText: 'text-muted-foreground',
	},
	failed: {
		label: 'Failed',
		Icon: AlertTriangle,
		pillBg: 'bg-status-failed-bg',
		pillText: 'text-status-failed-text',
	},
}

/**
 * Maps the loaded agent + session data to a PortraitStatus.
 * Prefers the persisted `agentState` (running/paused/failed take precedence),
 * but falls back to session-derived status for the 'failed' signal that the
 * backend may not have backfilled yet, and for surfacing in-flight sessions
 * that started before agentState landed.
 */
export function getPortraitStatus(
	agent: { agentState?: AgentState | null },
	sessionStatus: 'working' | 'idle' | 'failed',
): PortraitStatus {
	if (agent.agentState === 'running') return 'running'
	if (agent.agentState === 'paused') return 'paused'
	if (agent.agentState === 'failed') return 'failed'
	if (sessionStatus === 'working') return 'running'
	if (sessionStatus === 'failed') return 'failed'
	return 'idle'
}

/** Maps a portrait status to the existing All / Working / Idle / Failed filter buckets. */
export function portraitStatusToFilter(status: PortraitStatus): 'working' | 'idle' | 'failed' {
	if (status === 'running') return 'working'
	if (status === 'failed') return 'failed'
	return 'idle'
}
