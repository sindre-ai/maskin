import { useDuration } from '@/hooks/use-duration'
import type { ActorResponse, AgentState, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Pause, Play } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'
import { Spinner } from '../ui/spinner'
import { AgentRunPauseButton } from './agent-run-pause-button'

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

	const isRunning = status === 'running'

	return (
		<div
			className={cn(
				'group relative flex flex-col items-center gap-3 rounded-xl border bg-card p-5 text-center shadow-md transition-colors',
				isRunning && 'border-brand/60',
				status === 'failed' && 'border-error',
				status === 'paused' && 'border-border',
				status === 'idle' && 'border-border hover:border-border-strong',
			)}
		>
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: agent.id }}
				className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={`Open ${agent.name}`}
			/>

			<AvatarPortrait id={agent.id} name={agent.name} type={agent.type} status={status} />

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
				<AgentStatusPill status={status} />
			</div>

			<div className="relative mt-auto flex w-full items-center justify-center gap-2 pt-1">
				<AgentRunPauseButton
					isActive={isRunning}
					onRun={onRun}
					onPause={onPause}
					isRunPending={isRunPending}
					isPausePending={isPausePending}
					runLabel={status === 'paused' ? 'Resume' : 'Run'}
					fullWidth
				/>
			</div>
		</div>
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
	id,
	name,
	type,
	status,
}: {
	id: string
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
				? 'stroke-brand'
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
				<ActorAvatar id={id} name={name} type={type} size="md" className="h-12 w-12 text-base" />
			</div>
		</div>
	)
}

export function describeFocus(status: PortraitStatus, session?: SessionResponse): string {
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

/** The initials tile of an agent in the list and the detail hero (v11): tinted while it works, plain otherwise. */
export function agentTileClass(status: PortraitStatus): string {
	return status === 'running' ? 'bg-status-in_progress-bg text-success' : 'bg-muted text-foreground'
}

/** The avatar's status dot for a portrait status: working or failed, nothing otherwise. */
export function agentAvatarStatus(status: PortraitStatus): 'working' | 'failed' | undefined {
	return status === 'running' ? 'working' : status === 'failed' ? 'failed' : undefined
}

/** Pill used by any surface that shows an agent's portrait status as a row/card badge. */
export function AgentStatusPill({
	status,
	pulse = false,
	variant = 'pill',
	neutral = false,
}: {
	status: PortraitStatus
	/** Draws a running pill on the neutral plate the other statuses use (the agents list). */
	neutral?: boolean
	/** Swaps the leading glyph for a status dot that pulses while the agent is
	 *  live — the agent-detail header's treatment (mockup 2360). Everywhere else
	 *  keeps the icon so the pill still reads at row density. */
	pulse?: boolean
	/** `inline` drops the plate: a 6px dot and the label in the status colour,
	 *  which is how the agents list draws it (mockup 2337). `bare` drops the dot
	 *  too, leaving the coloured word alone — the agent-detail identity row
	 *  (mockup 2321). The filled pill is for a card, where the status has to hold
	 *  its own against a portrait. */
	variant?: 'pill' | 'inline' | 'bare'
}) {
	const meta = STATUS_META[status]
	const isRunning = status === 'running'
	if (variant === 'bare') {
		return <span className={cn('font-semibold', meta.inlineText)}>{meta.label}</span>
	}
	if (variant === 'inline') {
		return (
			<span className={cn('inline-flex items-center gap-1.5 font-semibold', meta.inlineText)}>
				<span
					aria-hidden="true"
					className={cn('size-1.5 shrink-0 rounded-full', meta.dot, isRunning && 'animate-pulse')}
				/>
				{meta.label}
			</span>
		)
	}
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-semibold',
				neutral ? 'bg-muted' : meta.pillBg,
				meta.pillText,
			)}
		>
			{pulse ? (
				<StatusGlyph status={status} className={cn(meta.glyph, isRunning && 'animate-pulse')} />
			) : isRunning ? (
				<Spinner className="size-3" aria-hidden="true" />
			) : (
				<meta.Icon className="size-3" aria-hidden="true" />
			)}
			{meta.label}
		</span>
	)
}

/**
 * The v16 status mark: a half-filled ring while working, a filled disc with a cross when
 * failed, an empty ring otherwise. Drawn so the pill reads by shape as well as colour.
 */
function StatusGlyph({ status, className }: { status: PortraitStatus; className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 16 16"
			className={cn('size-3.5 shrink-0', className)}
			fill="none"
		>
			{status === 'failed' ? (
				<>
					<circle cx="8" cy="8" r="7" fill="currentColor" />
					<path
						d="M5.5 5.5l5 5m0-5l-5 5"
						className="stroke-muted"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				</>
			) : (
				<>
					<circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
					{status === 'running' && <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />}
				</>
			)}
		</svg>
	)
}

interface StatusMeta {
	label: string
	Icon: typeof Pause
	pillBg: string
	pillText: string
	/** Semantic token class for the dot form of the pill. */
	dot: string
	/** Colour of the pill's leading status mark. */
	glyph: string
	/** Label colour for the plate-less `inline` variant. */
	inlineText: string
}

const STATUS_META: Record<PortraitStatus, StatusMeta> = {
	running: {
		label: 'Working',
		Icon: Play,
		// v3: the hero pill carries the Working-now card's cobalt tint; the list passes `neutral`.
		pillBg: 'bg-status-in_progress-bg',
		pillText: 'text-foreground',
		dot: 'bg-success',
		glyph: 'text-success',
		inlineText: 'text-status-in_progress-text',
	},
	// `text-muted-foreground` on `bg-muted` is 4.39:1 in light mode — below the
	// 4.5:1 WCAG AA floor at the 11px the agent header renders this pill at, so
	// the neutral statuses take the foreground token and leave the dot muted.
	paused: {
		label: 'Paused',
		Icon: Pause,
		pillBg: 'bg-muted',
		pillText: 'text-foreground',
		dot: 'bg-muted-foreground',
		glyph: 'text-muted-foreground',
		inlineText: 'text-muted-foreground',
	},
	idle: {
		label: 'Idle',
		Icon: Pause,
		pillBg: 'bg-muted',
		pillText: 'text-foreground',
		dot: 'bg-muted-foreground',
		glyph: 'text-muted-foreground',
		inlineText: 'text-muted-foreground',
	},
	failed: {
		label: 'Failed',
		Icon: AlertTriangle,
		pillBg: 'bg-muted',
		pillText: 'text-foreground',
		dot: 'bg-status-failed-text',
		glyph: 'text-status-failed-text',
		inlineText: 'text-status-failed-text',
	},
}

/**
 * Maps the loaded agent + session data to a PortraitStatus.
 *
 * A live active session is ground truth — if the agent has a session currently
 * running/starting/pending it IS working right now, even if the persisted
 * `agentState` still reads `paused` or `failed` from a prior lifecycle (state
 * transitions to `running` land asynchronously, and a resume kicks off a new
 * session before the column is updated). Without this override, an agent with
 * an in-flight session is hidden from the Working filter.
 *
 * Otherwise defer to the persisted `agentState`, falling back to session-derived
 * 'failed' when the backend hasn't backfilled it yet.
 */
export function getPortraitStatus(
	agent: { agentState?: AgentState | null },
	sessionStatus: 'working' | 'idle' | 'failed',
): PortraitStatus {
	if (sessionStatus === 'working') return 'running'
	if (agent.agentState === 'running') return 'running'
	if (agent.agentState === 'paused') return 'paused'
	if (agent.agentState === 'failed') return 'failed'
	if (sessionStatus === 'failed') return 'failed'
	return 'idle'
}

/** Maps a portrait status to the existing All / Working / Idle / Failed filter buckets. */
export function portraitStatusToFilter(status: PortraitStatus): 'working' | 'idle' | 'failed' {
	if (status === 'running') return 'working'
	if (status === 'failed') return 'failed'
	return 'idle'
}
