import { AgentOutput } from '@/components/shared/agent-output'
import { ObjectReference } from '@/components/shared/object-reference'
import { useSessionAffectedObjects } from '@/hooks/use-events'
import { useCreateSession, useSessionLogs } from '@/hooks/use-sessions'
import { trackEvent } from '@/lib/analytics'
import type { SessionLogResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { Link } from '@tanstack/react-router'
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	ExternalLink,
	FileText,
	MinusCircle,
	PauseCircle,
	Terminal,
	XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { RelativeTime } from '../shared/relative-time'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Spinner } from '../ui/spinner'
import {
	SessionLogTranscript,
	getSessionResultDisplay,
	isSessionIdleAwaitingInput,
} from './session-log-transcript'

export interface FailureReason {
	provider: string
	reason_code: string
	human_message: string
	http_status: number | null
	reset_at: string | null
	verbatim_output: string | null
}

export function parseFailureReason(result: Record<string, unknown> | null): FailureReason | null {
	if (!result) return null
	const fr = result.failure_reason
	if (!fr || typeof fr !== 'object') return null
	const obj = fr as Record<string, unknown>
	if (typeof obj.provider !== 'string' || typeof obj.reason_code !== 'string') return null
	return {
		provider: obj.provider,
		reason_code: obj.reason_code,
		human_message: typeof obj.human_message === 'string' ? obj.human_message : '',
		http_status: typeof obj.http_status === 'number' ? obj.http_status : null,
		reset_at: typeof obj.reset_at === 'string' ? obj.reset_at : null,
		verbatim_output: typeof obj.verbatim_output === 'string' ? obj.verbatim_output : null,
	}
}

const TOP_UP_URLS: Record<string, string> = {
	anthropic: 'https://console.anthropic.com/settings/plans',
	openrouter: 'https://openrouter.ai/credits',
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: 'Anthropic',
	openrouter: 'OpenRouter',
	'claude-code': 'Claude Code',
}

// Reason codes that show the recovery row (credit depletion + temporary quota limits).
// Matches the codes emitted by credit-classifier.ts.
const CREDIT_REASON_CODES = new Set([
	'billing_error',
	'credit_balance_low',
	'insufficient_credits',
	'session_limit',
	'weekly_limit',
	'opus_limit',
	'max_plan_rate_limit',
	'server_rate_limit',
	'request_rejected_429',
])

// Codes that require topping up credits (subset of CREDIT_REASON_CODES).
// max_plan_rate_limit is excluded — it's a temporary rate limit, not credit depletion.
const TOPUP_REASON_CODES = new Set([
	'billing_error',
	'credit_balance_low',
	'insufficient_credits',
	'session_limit',
	'weekly_limit',
	'opus_limit',
])

// Codes where the agent couldn't authenticate — recovery is connecting credentials.
const AUTH_REASON_CODES = new Set(['not_logged_in'])

export function FailureCard({
	failureReason,
	workspaceId,
}: { failureReason: FailureReason; workspaceId: string }) {
	const [showVerbatim, setShowVerbatim] = useState(false)
	const topUpUrl = TOP_UP_URLS[failureReason.provider]
	const isCredit = CREDIT_REASON_CODES.has(failureReason.reason_code)
	const isTopUp = TOPUP_REASON_CODES.has(failureReason.reason_code)
	const isAuth = AUTH_REASON_CODES.has(failureReason.reason_code)
	const isOpenRouter = failureReason.provider === 'openrouter'
	const providerLabel =
		PROVIDER_LABELS[failureReason.provider] ??
		failureReason.provider.charAt(0).toUpperCase() + failureReason.provider.slice(1)

	return (
		<div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-3 space-y-2">
			<p className="text-sm font-bold text-warning">
				{providerLabel} — {failureReason.human_message}
			</p>
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded-md bg-warning/10 text-warning border border-warning/20">
					{failureReason.provider}
				</span>
				<span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
					{failureReason.reason_code}
				</span>
				{failureReason.http_status !== null && (
					<span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
						HTTP {failureReason.http_status}
					</span>
				)}
				{failureReason.reset_at && (
					<span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-warning/10 text-warning border border-warning/20">
						<Clock size={10} />
						resets <RelativeTime date={failureReason.reset_at} />
					</span>
				)}
			</div>
			{isCredit && (
				<div className="flex flex-wrap items-center gap-2">
					{isTopUp && topUpUrl && (
						<Button size="sm" asChild>
							<a href={topUpUrl} target="_blank" rel="noreferrer">
								Top up {providerLabel} credits
								<ExternalLink size={12} className="ml-1" />
							</a>
						</Button>
					)}
					{isTopUp && !isOpenRouter && (
						<Button size="sm" variant="outline" asChild>
							<Link to="/$workspaceId/settings/keys" params={{ workspaceId }}>
								Switch to OpenRouter key
							</Link>
						</Button>
					)}
					<span className="inline-flex items-center text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground">
						Wait
					</span>
				</div>
			)}
			{isAuth && (
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" asChild>
						<Link to="/$workspaceId/settings/keys" params={{ workspaceId }}>
							Connect Claude subscription
						</Link>
					</Button>
				</div>
			)}
			{failureReason.verbatim_output && (
				<div>
					<button
						type="button"
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
						onClick={() => setShowVerbatim((v) => !v)}
					>
						{showVerbatim ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
						Provider output
					</button>
					{showVerbatim && (
						<pre className="mt-1 text-xs font-mono text-muted-foreground bg-muted/30 rounded p-2 whitespace-pre-wrap overflow-auto max-h-40">
							{failureReason.verbatim_output}
						</pre>
					)}
				</div>
			)}
		</div>
	)
}

interface SessionDetailPanelProps {
	session: SessionResponse | null
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

function SessionStatusBadge({ status }: { status: string }) {
	const config: Record<string, { icon: React.ElementType; label: string; className: string }> = {
		completed: {
			icon: CheckCircle2,
			label: 'Completed',
			className: 'bg-status-completed-bg text-status-completed-text',
		},
		failed: {
			icon: XCircle,
			label: 'Failed',
			className: 'bg-status-failed-bg text-status-failed-text',
		},
		timeout: {
			icon: Clock,
			label: 'Timed out',
			className: 'bg-status-failed-bg text-status-failed-text',
		},
		running: {
			icon: Spinner,
			label: 'Running',
			className: 'bg-status-processing-bg text-status-processing-text',
		},
		starting: {
			icon: Spinner,
			label: 'Starting',
			className: 'bg-status-processing-bg text-status-processing-text',
		},
		paused: {
			icon: Clock,
			label: 'Paused',
			className: 'bg-status-paused-bg text-status-paused-text',
		},
		snapshotting: {
			icon: Clock,
			label: 'Snapshotting',
			className: 'bg-status-processing-bg text-status-processing-text',
		},
		idle: {
			icon: PauseCircle,
			label: 'Idle',
			className: 'bg-muted text-muted-foreground',
		},
	}

	const {
		icon: Icon,
		label,
		className,
	} = config[status] ?? {
		icon: MinusCircle,
		label: status,
		className: 'bg-muted text-muted-foreground',
	}

	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
				className,
			)}
		>
			<Icon size={12} />
			{label}
		</span>
	)
}

function ExpandableTitle({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false)
	const isLong = text.length > 120
	if (!isLong) {
		return <span>{text}</span>
	}
	return (
		<button
			type="button"
			onClick={() => setExpanded((v) => !v)}
			className="text-left w-full flex items-start gap-1.5 cursor-pointer group"
			aria-expanded={expanded}
		>
			<span className="mt-0.5 shrink-0 text-text-muted group-hover:text-text-secondary">
				{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
			</span>
			<span className={cn('flex-1 min-w-0 break-words', !expanded && 'line-clamp-2')}>{text}</span>
		</button>
	)
}

function RawLogsView({ logs }: { logs: SessionLogResponse[] }) {
	if (logs.length === 0) {
		return <p className="text-sm text-muted-foreground py-4 text-center">No logs available</p>
	}
	return (
		<div className="rounded-md border border-border bg-secondary/30 overflow-hidden">
			<div className="max-h-[60vh] overflow-y-auto">
				<pre className="text-xs font-mono p-3 whitespace-pre-wrap break-words">
					{logs.map((log) => (
						<div
							key={log.id}
							className={cn(
								'py-0.5',
								log.stream === 'stderr' && 'text-error',
								log.stream === 'system' && 'text-muted-foreground italic',
							)}
						>
							{log.content}
						</div>
					))}
				</pre>
			</div>
		</div>
	)
}

type LogView = 'transcript' | 'raw'

const RESTARTABLE_STATUSES = new Set(['failed', 'timeout', 'completed'])

function RestartSessionButton({
	session,
	workspaceId,
}: { session: SessionResponse; workspaceId: string }) {
	const createSession = useCreateSession(workspaceId)
	return (
		<button
			type="button"
			className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] inline-flex items-center"
			disabled={createSession.isPending}
			onClick={() => {
				trackEvent('session_restart_clicked', {
					source: 'session-detail-panel',
					session_id: session.id,
					actor_id: session.actorId,
					prior_status: session.status,
				})
				createSession.mutate({
					actor_id: session.actorId,
					action_prompt: session.actionPrompt,
				})
			}}
		>
			{createSession.isPending ? 'Restarting…' : 'Restart'}
		</button>
	)
}

export function SessionDetailPanel({
	session,
	workspaceId,
	open,
	onOpenChange,
}: SessionDetailPanelProps) {
	const isLive =
		session?.status === 'running' ||
		session?.status === 'starting' ||
		session?.status === 'snapshotting'
	const { data: logs, isLoading: logsLoading } = useSessionLogs(
		session?.id ?? null,
		workspaceId,
		open,
		{ live: open && isLive },
	)
	const { affectedObjects, isLoading: objectsLoading } = useSessionAffectedObjects(
		session?.startedAt ?? null,
		session?.completedAt ?? null,
		workspaceId,
		open && !!session,
	)
	const [logView, setLogView] = useState<LogView>('transcript')

	const duration = session ? formatDurationBetween(session.startedAt, session.completedAt) : null
	const result = session?.result as Record<string, unknown> | null
	const errorMessage = typeof result?.error === 'string' ? result.error : undefined
	const rawExitCode = result?.exit_code
	const exitCode: number | null | undefined =
		typeof rawExitCode === 'number' || rawExitCode === null ? rawExitCode : undefined
	const failureReason = parseFailureReason(result)

	const lastResult = useMemo(() => getSessionResultDisplay(logs ?? []), [logs])
	const idleAwaitingInput = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const displayStatus =
		session?.status === 'running' && idleAwaitingInput ? 'idle' : (session?.status ?? '')

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
				{session && (
					<>
						<SheetHeader className="pr-6">
							<SheetTitle className="text-base font-semibold" asChild>
								<div>
									<ExpandableTitle text={session.actionPrompt || 'Untitled session'} />
								</div>
							</SheetTitle>
							<SheetDescription className="sr-only">Session details</SheetDescription>
						</SheetHeader>

						{/* Metadata */}
						<div className="mt-4 space-y-3">
							<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
								<SessionStatusBadge status={displayStatus} />
								{RESTARTABLE_STATUSES.has(session.status) && (
									<RestartSessionButton session={session} workspaceId={workspaceId} />
								)}
								{duration && (
									<span className="text-muted-foreground flex items-center gap-1">
										<Clock size={13} />
										{duration}
									</span>
								)}
								{session.startedAt && (
									<RelativeTime
										date={session.startedAt}
										className="text-muted-foreground text-sm"
									/>
								)}
							</div>

							{/* Error / non-zero exit code */}
							{failureReason ? (
								<FailureCard failureReason={failureReason} workspaceId={workspaceId} />
							) : (
								(errorMessage || (exitCode !== undefined && exitCode !== 0)) && (
									<div className="rounded-md bg-error/10 border border-error/20 px-3 py-2">
										<p className="text-sm text-error font-medium">
											{errorMessage ??
												(exitCode !== null
													? `Process exited with code ${exitCode}`
													: 'Container process was killed')}
										</p>
									</div>
								)
							)}
						</div>

						{/* Result — agent's last output */}
						{lastResult && (
							<div className="mt-6">
								<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
									Result
								</h4>
								<div
									className={cn(
										'rounded-md border p-3',
										lastResult.isError
											? 'border-error/20 bg-error/5'
											: 'border-border bg-secondary/30',
									)}
								>
									<AgentOutput content={lastResult.text} size="sm" />
								</div>
							</div>
						)}

						{/* Objects affected */}
						<div className="mt-6">
							<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-2">
								<FileText size={13} />
								Objects affected
								{affectedObjects.length > 0 && (
									<span className="opacity-60">({affectedObjects.length})</span>
								)}
							</h4>
							{objectsLoading ? (
								<div className="flex items-center justify-center py-4">
									<Spinner />
								</div>
							) : affectedObjects.length === 0 ? (
								<p className="text-sm text-muted-foreground py-2 text-center">
									No objects affected
								</p>
							) : (
								<div className="space-y-1">
									{affectedObjects.map((obj) => (
										<ObjectReference
											key={obj.entityId}
											objectId={obj.entityId}
											workspaceId={workspaceId}
											variant="block"
										/>
									))}
								</div>
							)}
						</div>

						{/* Logs */}
						<div className="mt-6">
							<div className="flex items-center justify-between mb-2">
								<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
									<Terminal size={13} />
									Logs
								</h4>
								<div className="flex items-center gap-1">
									{(['transcript', 'raw'] as const).map((view) => (
										<button
											key={view}
											type="button"
											className={cn(
												'text-[11px] px-1.5 py-0.5 rounded transition-colors cursor-pointer capitalize',
												logView === view
													? 'bg-accent text-accent-foreground'
													: 'text-muted-foreground hover:text-foreground',
											)}
											onClick={() => setLogView(view)}
										>
											{view}
										</button>
									))}
								</div>
							</div>

							{logsLoading ? (
								<div className="flex items-center justify-center py-8">
									<Spinner />
								</div>
							) : logView === 'transcript' ? (
								<SessionLogTranscript logs={logs ?? []} />
							) : (
								<RawLogsView logs={logs ?? []} />
							)}
						</div>

						{/* Session ID */}
						<div className="mt-6 pt-4 border-t border-border">
							<p className="text-[11px] text-muted-foreground font-mono break-all">
								Session: {session.id}
							</p>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	)
}
