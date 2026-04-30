import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Pause, Play, Square } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { SessionResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

const TERMINAL = new Set(['completed', 'failed', 'timeout'])
const RUNNING = new Set(['running', 'starting', 'snapshotting'])

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

type SessionLog = { id?: number; stream?: string; line?: string; createdAt?: string | null }

interface SessionWithLogsEnvelope {
	session: SessionResponse
	logs?: SessionLog[]
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
				<SessionListView sessions={unwrapped as SessionResponse[]} />
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
			return isObject<SessionResponse>(data, 'id', 'status') ? (
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

function SessionListView({ sessions }: { sessions: SessionResponse[] }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<SessionResponse[]>(sessions)
	const [busyId, setBusyId] = useState<string | null>(null)

	useEffect(() => {
		setLocal(sessions)
	}, [sessions])

	const runAction = useCallback(
		async (
			session: SessionResponse,
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
	onPause,
	onResume,
	onStop,
}: {
	session: SessionResponse
	busy: boolean
	onPause: () => void
	onResume: () => void
	onStop: () => void
}) {
	const isRunning = RUNNING.has(session.status)
	const isPaused = session.status === 'paused'
	const isTerminal = TERMINAL.has(session.status)
	return (
		<div className="rounded-lg border border-border bg-bg-surface p-3 flex items-start gap-3">
			<div className="flex-1 min-w-0">
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
			</div>
			<div className="flex items-center gap-1 shrink-0">
				<WebAppLink target={{ kind: 'session', id: session.id, actorId: session.actorId }} />
				{isRunning && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={onPause} title="Pause">
						<Pause className="size-4" />
					</Button>
				)}
				{isPaused && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={onResume} title="Resume">
						<Play className="size-4" />
					</Button>
				)}
				{!isTerminal && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={onStop} title="Stop">
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
}: {
	session: SessionResponse
	logs?: SessionLog[]
}) {
	const callTool = useCallTool()
	const [current, setCurrent] = useState<SessionResponse>(session)
	const [busy, setBusy] = useState(false)

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
					if (isObject<SessionResponse>(next, 'id', 'status')) {
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

	return (
		<div className="p-4 max-w-3xl space-y-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2 flex-wrap">
					<Badge variant={STATUS_VARIANTS[current.status] ?? 'secondary'}>{current.status}</Badge>
					<span className="font-mono text-xs text-muted-foreground">{current.id}</span>
				</div>
				<WebAppLink
					target={{ kind: 'session', id: current.id, actorId: current.actorId }}
					label="Open in Maskin"
				/>
			</div>

			{current.actionPrompt && (
				<div>
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
						Action prompt
					</h3>
					<p className="text-sm text-foreground whitespace-pre-wrap">{current.actionPrompt}</p>
				</div>
			)}

			<div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{current.startedAt && (
					<div>
						<span className="text-muted-foreground">Started:</span>{' '}
						<RelativeTime date={current.startedAt} />
					</div>
				)}
				{current.completedAt && (
					<div>
						<span className="text-muted-foreground">Completed:</span>{' '}
						<RelativeTime date={current.completedAt} />
					</div>
				)}
				{current.actorId && (
					<div className="col-span-2">
						<span className="text-muted-foreground">Actor:</span>{' '}
						<span className="font-mono">{current.actorId}</span>
					</div>
				)}
			</div>

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

			{logs && logs.length > 0 && (
				<div>
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
						Logs
					</h3>
					<pre className="text-xs font-mono bg-card border border-border rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
						{logs.map((l) => `${l.stream ? `[${l.stream}] ` : ''}${l.line ?? ''}`).join('\n')}
					</pre>
				</div>
			)}
		</div>
	)
}

renderMcpApp('Sessions', <SessionsApp />)
