import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { ArrowLeft, Clock, Pause, Play, Square, Terminal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { SessionResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

const TERMINAL = new Set(['completed', 'failed', 'timeout'])
const RUNNING = new Set(['running', 'starting', 'snapshotting'])

type SessionLog = { id?: number; stream?: string; content?: string; createdAt?: string | null }
type LogFilter = 'all' | 'stdout' | 'stderr' | 'system'
type SessionMutation = 'pause_session' | 'resume_session' | 'stop_session'

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

type ToolResult = { content?: Array<{ type: string; text?: string }> }

function actorDisplay(session: { actorName?: string; actorId: string }): string {
	if (session.actorName) return session.actorName
	return session.actorId.slice(0, 8)
}

/** Pull `{ session, logs? }` out of any session-tool response shape. */
function parseSessionFromResult(result: ToolResult): SessionWithLogsEnvelope | null {
	const text = result.content?.find((c) => c.type === 'text')?.text
	if (!text) return null
	const unwrapped = unwrapEnvelope(safeParseJson(text))
	if (isObject<SessionWithLogsEnvelope>(unwrapped, 'session')) {
		return { session: unwrapped.session, logs: unwrapped.logs }
	}
	if (isObject<EnrichedSession>(unwrapped, 'id', 'status')) {
		return { session: unwrapped }
	}
	return null
}

/**
 * Shared optimistic-update flow for pause/resume/stop. Caller supplies the
 * apply/rollback callbacks that mutate its local state, plus optional
 * `applySession` to absorb the full updated session from the response.
 */
function useSessionMutation(applySession?: (session: EnrichedSession) => void) {
	const callTool = useCallTool()
	const [busyId, setBusyId] = useState<string | null>(null)

	const run = useCallback(
		async (params: {
			session: EnrichedSession
			tool: SessionMutation
			applyOptimistic: () => void
			rollback: () => void
		}) => {
			setBusyId(params.session.id)
			params.applyOptimistic()
			try {
				const result = await callTool(params.tool, { id: params.session.id })
				if (applySession) {
					const parsed = parseSessionFromResult(result)
					if (parsed?.session) applySession(parsed.session)
				}
			} catch (err) {
				params.rollback()
				console.error(`Failed to ${params.tool}`, err)
			} finally {
				setBusyId(null)
			}
		},
		[callTool, applySession],
	)

	return { busyId, run }
}

/**
 * Pause/resume/stop button group, shared between row and detail views.
 * `variant: 'icon'` is icon-only ghost buttons (stops click bubbling so the
 * surrounding row's onSelect doesn't fire); `variant: 'labeled'` is icon+label
 * outline buttons.
 */
function SessionActions({
	session,
	busy,
	variant,
	onPause,
	onResume,
	onStop,
}: {
	session: EnrichedSession
	busy: boolean
	variant: 'icon' | 'labeled'
	onPause: () => void
	onResume: () => void
	onStop: () => void
}) {
	const isRunning = RUNNING.has(session.status)
	const isPaused = session.status === 'paused'
	const isTerminal = TERMINAL.has(session.status)
	const buttonVariant = variant === 'icon' ? 'ghost' : 'outline'

	const handle = (fn: () => void) => (e: React.MouseEvent) => {
		if (variant === 'icon') e.stopPropagation()
		fn()
	}

	const buttons: Array<{ show: boolean; icon: typeof Pause; label: string; onClick: () => void }> =
		[
			{ show: isRunning, icon: Pause, label: 'Pause', onClick: onPause },
			{ show: isPaused, icon: Play, label: 'Resume', onClick: onResume },
			{ show: !isTerminal, icon: Square, label: 'Stop', onClick: onStop },
		]

	return (
		<>
			{buttons
				.filter((b) => b.show)
				.map(({ icon: Icon, label, onClick }) => (
					<Button
						key={label}
						size="sm"
						variant={buttonVariant}
						disabled={busy}
						onClick={handle(onClick)}
						title={label}
					>
						<Icon className={cn('size-4', variant === 'labeled' && 'mr-1')} />
						{variant === 'labeled' && label}
					</Button>
				))}
		</>
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

	if (toolResult.toolName === 'list_sessions') {
		const unwrapped = unwrapEnvelope(data)
		return isArray(unwrapped) ? (
			<SessionListView sessions={unwrapped as EnrichedSession[]} />
		) : (
			<div className="p-4 text-sm text-foreground">{text}</div>
		)
	}

	// create_session, get_session, pause_session, resume_session, stop_session,
	// run_agent — all return either { session, logs? } or a raw session.
	const parsed = parseSessionFromResult(toolResult.result)
	if (parsed) return <SessionDetailView session={parsed.session} logs={parsed.logs} />
	return <div className="p-4 text-sm text-foreground">{text}</div>
}

function SessionListView({ sessions }: { sessions: EnrichedSession[] }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<EnrichedSession[]>(sessions)
	const [selected, setSelected] = useState<{
		session: EnrichedSession
		logs?: SessionLog[]
		loading: boolean
	} | null>(null)

	useEffect(() => {
		setLocal(sessions)
	}, [sessions])

	const { busyId, run } = useSessionMutation()

	const handleAction = useCallback(
		(session: EnrichedSession, tool: SessionMutation, optimisticStatus: string) => {
			const previous = session.status
			const setStatus = (status: string) =>
				setLocal((cur) => cur.map((s) => (s.id === session.id ? { ...s, status } : s)))
			run({
				session,
				tool,
				applyOptimistic: () => setStatus(optimisticStatus),
				rollback: () => setStatus(previous),
			})
		},
		[run],
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
				const parsed = parseSessionFromResult(result)
				setSelected(
					parsed
						? { session: parsed.session, logs: parsed.logs, loading: false }
						: { session, loading: false },
				)
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
					onPause={() => handleAction(session, 'pause_session', 'paused')}
					onResume={() => handleAction(session, 'resume_session', 'running')}
					onStop={() => handleAction(session, 'stop_session', 'completed')}
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
	return (
		<div className="rounded-lg border border-border bg-bg-surface p-3 flex items-start gap-3 hover:border-border-hover hover:bg-bg-hover transition-colors">
			<button
				type="button"
				onClick={onSelect}
				className="flex-1 min-w-0 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
			>
				<div className="flex items-center gap-2 flex-wrap">
					<StatusBadge status={session.status} />
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
				<SessionActions
					session={session}
					busy={busy}
					variant="icon"
					onPause={onPause}
					onResume={onResume}
					onStop={onStop}
				/>
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
	const [current, setCurrent] = useState<EnrichedSession>(session)
	const [logFilter, setLogFilter] = useState<LogFilter>('all')

	useEffect(() => {
		setCurrent(session)
	}, [session])

	const { busyId, run } = useSessionMutation(setCurrent)
	const busy = busyId === current.id

	const handleAction = useCallback(
		(tool: SessionMutation, optimisticStatus: string) => {
			const previous = current.status
			run({
				session: current,
				tool,
				applyOptimistic: () => setCurrent((c) => ({ ...c, status: optimisticStatus })),
				rollback: () => setCurrent((c) => ({ ...c, status: previous })),
			})
		},
		[run, current],
	)

	const isRunning = RUNNING.has(current.status)
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
				<div className="flex items-center gap-1.5">
					<StatusBadge status={current.status} />
					{isRunning && <Spinner className="size-3 text-accent" />}
				</div>
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
				<SessionActions
					session={current}
					busy={busy}
					variant="labeled"
					onPause={() => handleAction('pause_session', 'paused')}
					onResume={() => handleAction('resume_session', 'running')}
					onStop={() => handleAction('stop_session', 'completed')}
				/>
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
