import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import {
	ArrowLeft,
	CheckCircle2,
	Clock,
	MinusCircle,
	Pause,
	Play,
	Square,
	Terminal,
	XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { SessionResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

const TERMINAL = new Set(['completed', 'failed', 'timeout'])
const RUNNING = new Set(['running', 'starting', 'snapshotting'])

const STATUS_CONFIG: Record<string, { icon: React.ElementType; label: string; className: string }> =
	{
		completed: { icon: CheckCircle2, label: 'Completed', className: 'text-success' },
		failed: { icon: XCircle, label: 'Failed', className: 'text-error' },
		timeout: { icon: Clock, label: 'Timed out', className: 'text-error' },
		running: { icon: Spinner, label: 'Running', className: 'text-accent' },
		starting: { icon: Spinner, label: 'Starting', className: 'text-accent' },
		paused: { icon: Clock, label: 'Paused', className: 'text-warning' },
		snapshotting: { icon: Clock, label: 'Snapshotting', className: 'text-warning' },
		pending: { icon: Clock, label: 'Pending', className: 'text-muted-foreground' },
	}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
	pending: 'secondary',
	starting: 'default',
	running: 'default',
	snapshotting: 'default',
	paused: 'outline',
	completed: 'secondary',
	failed: 'destructive',
	timeout: 'destructive',
}

type SessionLog = { id?: number; stream?: string; content?: string; createdAt?: string | null }
type LogFilter = 'all' | 'stdout' | 'stderr' | 'system'

/**
 * Server-side session payload, optionally enriched with `actorName` by the MCP
 * server's session handlers (it inlines the actor's display name so cards can
 * show "Sindre" instead of a raw UUID).
 */
type EnrichedSession = SessionResponse & { actorName?: string }

interface SessionWithLogsEnvelope {
	session: EnrichedSession
	logs?: SessionLog[]
}

function actorDisplay(session: { actorName?: string; actorId: string }): string {
	if (session.actorName) return session.actorName
	return session.actorId.slice(0, 8)
}

function SessionStatus({ status }: { status: string }) {
	const cfg = STATUS_CONFIG[status] ?? {
		icon: MinusCircle,
		label: status,
		className: 'text-muted-foreground',
	}
	const Icon = cfg.icon
	return (
		<span className={cn('flex items-center gap-1.5 text-sm font-medium', cfg.className)}>
			<Icon size={14} />
			{cfg.label}
		</span>
	)
}

function SessionsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	const unwrapped = unwrapEnvelope(data)

	switch (toolResult.toolName) {
		case 'list_sessions':
			return isArray(unwrapped) ? (
				<SessionListView sessions={unwrapped as EnrichedSession[]} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'create_session':
		case 'get_session':
		case 'pause_session':
		case 'resume_session':
		case 'stop_session':
			if (isObject<SessionWithLogsEnvelope>(data, 'session')) {
				return <SessionDetailView session={data.session} logs={data.logs} />
			}
			return isObject<EnrichedSession>(data, 'id', 'status') ? (
				<SessionDetailView session={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'run_agent':
			return isObject<SessionWithLogsEnvelope>(data, 'session') ? (
				<SessionDetailView session={data.session} logs={data.logs} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		default:
			return <div className="p-4 text-sm text-foreground">{text}</div>
	}
}

function SessionListView({ sessions }: { sessions: EnrichedSession[] }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<EnrichedSession[]>(sessions)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [selected, setSelected] = useState<{
		session: EnrichedSession
		logs?: SessionLog[]
		loading: boolean
	} | null>(null)

	useEffect(() => {
		setLocal(sessions)
	}, [sessions])

	const runAction = useCallback(
		async (
			session: EnrichedSession,
			tool: 'pause_session' | 'resume_session' | 'stop_session',
			optimisticStatus: string,
		) => {
			setBusyId(session.id)
			const previous = session.status
			setLocal((cur) =>
				cur.map((s) => (s.id === session.id ? { ...s, status: optimisticStatus } : s)),
			)
			try {
				await callTool(tool, { id: session.id })
			} catch (err) {
				setLocal((cur) => cur.map((s) => (s.id === session.id ? { ...s, status: previous } : s)))
				console.error(`Failed to ${tool}`, err)
			} finally {
				setBusyId(null)
			}
		},
		[callTool],
	)

	const openDetail = useCallback(
		async (session: EnrichedSession) => {
			setSelected({ session, loading: true })
			try {
				const result = await callTool('get_session', {
					id: session.id,
					include_logs: true,
					log_limit: 200,
				})
				const text = result.content?.find(
					(c: { type: string; text?: string }) => c.type === 'text',
				)?.text
				if (!text) {
					setSelected({ session, loading: false })
					return
				}
				const data = safeParseJson(text)
				if (isObject<SessionWithLogsEnvelope>(data, 'session')) {
					setSelected({ session: data.session, logs: data.logs, loading: false })
				} else if (isObject<EnrichedSession>(data, 'id', 'status')) {
					setSelected({ session: data, loading: false })
				} else {
					setSelected({ session, loading: false })
				}
			} catch (err) {
				console.error('Failed to load session detail', err)
				setSelected({ session, loading: false })
			}
		},
		[callTool],
	)

	if (selected) {
		return (
			<SessionDetailView
				session={selected.session}
				logs={selected.logs}
				loading={selected.loading}
				onBack={() => setSelected(null)}
			/>
		)
	}

	if (!local.length) {
		return <EmptyState title="No sessions" description="No agent sessions in this workspace yet" />
	}

	return (
		<div className="p-4 space-y-2">
			<div className="flex justify-end mb-2">
				<WebAppLink target={{ kind: 'activity' }} label="Open activity in Maskin" />
			</div>
			{local.map((session) => (
				<SessionRow
					key={session.id}
					session={session}
					busy={busyId === session.id}
					onSelect={() => openDetail(session)}
					onPause={() => runAction(session, 'pause_session', 'paused')}
					onResume={() => runAction(session, 'resume_session', 'running')}
					onStop={() => runAction(session, 'stop_session', 'completed')}
				/>
			))}
		</div>
	)
}

function SessionRow({
	session,
	busy,
	onSelect,
	onPause,
	onResume,
	onStop,
}: {
	session: EnrichedSession
	busy: boolean
	onSelect: () => void
	onPause: () => void
	onResume: () => void
	onStop: () => void
}) {
	const isRunning = RUNNING.has(session.status)
	const isPaused = session.status === 'paused'
	const isTerminal = TERMINAL.has(session.status)
	const stop = (handler: () => void) => (e: React.MouseEvent) => {
		e.stopPropagation()
		handler()
	}
	return (
		<div className="rounded-lg border border-border bg-bg-surface p-3 flex items-start gap-3 hover:border-border-hover hover:bg-bg-hover transition-colors">
			<button
				type="button"
				onClick={onSelect}
				className="flex-1 min-w-0 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
			>
				<div className="flex items-center gap-2 flex-wrap">
					<Badge variant={STATUS_VARIANTS[session.status] ?? 'secondary'}>{session.status}</Badge>
					<span className="font-mono text-xs text-muted-foreground truncate">{session.id}</span>
					{session.createdAt && (
						<span className="text-xs text-muted-foreground">
							<RelativeTime date={session.createdAt} />
						</span>
					)}
				</div>
				{session.actionPrompt && (
					<p className="text-sm text-foreground mt-1 line-clamp-2">{session.actionPrompt}</p>
				)}
			</button>
			<div className="flex items-center gap-1 shrink-0">
				<Badge variant="outline" className="font-medium">
					{actorDisplay(session)}
				</Badge>
				<WebAppLink target={{ kind: 'session', id: session.id, actorId: session.actorId }} />
				{isRunning && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={stop(onPause)} title="Pause">
						<Pause className="size-4" />
					</Button>
				)}
				{isPaused && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={stop(onResume)} title="Resume">
						<Play className="size-4" />
					</Button>
				)}
				{!isTerminal && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={stop(onStop)} title="Stop">
						<Square className="size-4" />
					</Button>
				)}
			</div>
		</div>
	)
}

function SessionDetailView({
	session,
	logs,
	loading,
	onBack,
}: {
	session: EnrichedSession
	logs?: SessionLog[]
	loading?: boolean
	onBack?: () => void
}) {
	const callTool = useCallTool()
	const [current, setCurrent] = useState<EnrichedSession>(session)
	const [busy, setBusy] = useState(false)
	const [logFilter, setLogFilter] = useState<LogFilter>('all')

	useEffect(() => {
		setCurrent(session)
	}, [session])

	const runAction = useCallback(
		async (tool: 'pause_session' | 'resume_session' | 'stop_session', optimisticStatus: string) => {
			setBusy(true)
			const previous = current.status
			setCurrent((c) => ({ ...c, status: optimisticStatus }))
			try {
				const result = await callTool(tool, { id: current.id })
				const text = result.content?.find(
					(c: { type: string; text?: string }) => c.type === 'text',
				)?.text
				if (text) {
					const next = safeParseJson(text)
					if (isObject<EnrichedSession>(next, 'id', 'status')) {
						setCurrent(next)
					}
				}
			} catch (err) {
				setCurrent((c) => ({ ...c, status: previous }))
				console.error(`Failed to ${tool}`, err)
			} finally {
				setBusy(false)
			}
		},
		[callTool, current.id, current.status],
	)

	const isRunning = RUNNING.has(current.status)
	const isPaused = current.status === 'paused'
	const isTerminal = TERMINAL.has(current.status)

	const duration = formatDurationBetween(current.startedAt, current.completedAt)
	const result = current.result as Record<string, unknown> | null
	const errorMessage = typeof result?.error === 'string' ? result.error : undefined
	const exitCode = typeof result?.exit_code === 'number' ? result.exit_code : undefined

	const logCounts = useMemo(() => {
		if (!logs) return { stdout: 0, stderr: 0, system: 0 }
		return logs.reduce(
			(acc, l) => {
				if (l.stream === 'stdout') acc.stdout++
				else if (l.stream === 'stderr') acc.stderr++
				else if (l.stream === 'system') acc.system++
				return acc
			},
			{ stdout: 0, stderr: 0, system: 0 },
		)
	}, [logs])

	const filteredLogs = useMemo(() => {
		if (!logs) return []
		if (logFilter === 'all') return logs
		return logs.filter((l) => l.stream === logFilter)
	}, [logs, logFilter])

	return (
		<div className="p-4 max-w-3xl space-y-4">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					{onBack && (
						<Button size="sm" variant="ghost" onClick={onBack} title="Back to list">
							<ArrowLeft className="size-4" />
						</Button>
					)}
					<h2 className="text-base font-semibold text-foreground truncate">
						{current.actionPrompt || 'Untitled session'}
					</h2>
				</div>
				<WebAppLink
					target={{ kind: 'session', id: current.id, actorId: current.actorId }}
					label="Open in Maskin"
				/>
			</div>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
				<SessionStatus status={current.status} />
				{duration && (
					<span className="text-muted-foreground flex items-center gap-1">
						<Clock size={13} />
						{duration}
					</span>
				)}
				{current.startedAt && (
					<RelativeTime date={current.startedAt} className="text-muted-foreground text-sm" />
				)}
				<Badge variant="outline" className="font-medium">
					{actorDisplay(current)}
				</Badge>
			</div>

			{(errorMessage || (exitCode !== undefined && exitCode !== 0)) && (
				<div className="rounded-md bg-error/10 border border-error/20 px-3 py-2">
					<p className="text-sm text-error font-medium">
						{errorMessage ?? `Process exited with code ${exitCode}`}
					</p>
				</div>
			)}

			<div className="flex items-center gap-2">
				{isRunning && (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => runAction('pause_session', 'paused')}
					>
						<Pause className="size-4 mr-1" /> Pause
					</Button>
				)}
				{isPaused && (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => runAction('resume_session', 'running')}
					>
						<Play className="size-4 mr-1" /> Resume
					</Button>
				)}
				{!isTerminal && (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => runAction('stop_session', 'completed')}
					>
						<Square className="size-4 mr-1" /> Stop
					</Button>
				)}
			</div>

			<div>
				<div className="flex items-center justify-between mb-2">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
						<Terminal size={13} />
						Logs
					</h3>
					{logs && logs.length > 0 && (
						<div className="flex items-center gap-1">
							{(['all', 'stdout', 'stderr', 'system'] as const).map((filter) => {
								const count =
									filter === 'all' ? logs.length : logCounts[filter as keyof typeof logCounts]
								return (
									<button
										key={filter}
										type="button"
										className={cn(
											'text-[11px] px-1.5 py-0.5 rounded transition-colors cursor-pointer',
											logFilter === filter
												? 'bg-accent text-accent-foreground'
												: 'text-muted-foreground hover:text-foreground',
										)}
										onClick={() => setLogFilter(filter)}
									>
										{filter}
										{count > 0 && <span className="ml-0.5 opacity-60">({count})</span>}
									</button>
								)
							})}
						</div>
					)}
				</div>

				{loading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner />
					</div>
				) : filteredLogs.length > 0 ? (
					<div className="rounded-md border border-border bg-secondary/30 overflow-hidden">
						<div className="max-h-[60vh] overflow-y-auto">
							<pre className="text-xs font-mono p-3 whitespace-pre-wrap break-words">
								{filteredLogs.map((log, idx) => (
									<div
										key={log.id ?? idx}
										className={cn(
											'py-0.5',
											log.stream === 'stderr' && 'text-error',
											log.stream === 'system' && 'text-muted-foreground italic',
										)}
									>
										{log.content ?? ''}
									</div>
								))}
							</pre>
						</div>
					</div>
				) : (
					<p className="text-sm text-muted-foreground py-4 text-center">No logs available</p>
				)}
			</div>

			{result && Object.keys(result).length > 0 && (
				<div>
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Result
					</h3>
					<pre className="text-xs font-mono rounded-md border border-border bg-secondary/30 p-3 whitespace-pre-wrap break-words">
						{JSON.stringify(result, null, 2)}
					</pre>
				</div>
			)}

			<div className="pt-2 border-t border-border">
				<p className="text-[11px] text-muted-foreground font-mono">Session: {current.id}</p>
			</div>
		</div>
	)
}

renderMcpApp('Sessions', <SessionsApp />)
