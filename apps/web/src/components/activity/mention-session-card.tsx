import { SessionDetailPanel } from '@/components/agents/session-detail-panel'
import {
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActor } from '@/hooks/use-actors'
import { useSessionLogs, useStopSession } from '@/hooks/use-sessions'
import type { SessionLogResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { type SindreEvent, parseSindreLine } from '@/lib/sindre-stream'
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Loader2,
	Square,
	XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'paused'])

interface MentionSessionCardProps {
	session: SessionResponse
	workspaceId: string
}

export function MentionSessionCard({ session, workspaceId }: MentionSessionCardProps) {
	const [panelOpen, setPanelOpen] = useState(false)
	const isTerminal = TERMINAL_STATUSES.has(session.status)

	return (
		<>
			{isTerminal ? (
				<TerminalCard session={session} onOpen={() => setPanelOpen(true)} />
			) : (
				<ActiveCard
					session={session}
					workspaceId={workspaceId}
					onOpen={() => setPanelOpen(true)}
				/>
			)}
			<SessionDetailPanel
				session={session}
				workspaceId={workspaceId}
				open={panelOpen}
				onOpenChange={setPanelOpen}
			/>
		</>
	)
}

function PulsingDots() {
	return (
		<span className="inline-flex items-center gap-0.5">
			<span className="size-1.5 rounded-full bg-current animate-pulse" />
			<span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
			<span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
		</span>
	)
}

function ActiveCard({
	session,
	workspaceId,
	onOpen,
}: {
	session: SessionResponse
	workspaceId: string
	onOpen: () => void
}) {
	const [collapsed, setCollapsed] = useState(true)
	const { data: actor } = useActor(session.actorId)
	const { data: logs } = useSessionLogs(session.id, workspaceId, true, { live: true })
	const stopMutation = useStopSession(workspaceId)

	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const activities = useMemo(() => extractSemanticActivities(logs ?? []), [logs])

	const label = idle
		? `${actor?.name ?? 'Agent'} is waiting`
		: `${actor?.name ?? 'Agent'} is working`

	return (
		<div className="rounded-md border border-border bg-secondary/30 animate-in fade-in slide-in-from-bottom-1 duration-200">
			{/* Header — pulsing indicator renders from mount without waiting for logs */}
			<div className="flex items-center gap-2 px-3 py-2">
				<span className={cn('shrink-0', idle ? 'text-muted-foreground' : 'text-primary')}>
					{idle ? <Clock size={14} /> : <PulsingDots />}
				</span>
				{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
				<span className="text-sm font-medium shrink-0">{label}</span>
				{preview && (
					<span className="text-sm text-muted-foreground truncate min-w-0 flex-1">
						{preview}
					</span>
				)}
				<div className="ml-auto shrink-0 flex items-center gap-0.5">
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation()
							stopMutation.mutate(session.id)
						}}
						disabled={stopMutation.isPending}
						className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
						aria-label="Stop session"
						title="Stop session"
					>
						{stopMutation.isPending ? (
							<Loader2 size={12} className="animate-spin" />
						) : (
							<Square size={12} />
						)}
					</button>
					{activities.length > 0 && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation()
								setCollapsed((v) => !v)
							}}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							aria-label={collapsed ? 'Show activity' : 'Hide activity'}
							aria-expanded={!collapsed}
						>
							{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
						</button>
					)}
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation()
							onOpen()
						}}
						className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
					>
						logs
					</button>
				</div>
			</div>

			{/* Semantic activity checklist — visible when expanded */}
			{!collapsed && activities.length > 0 && (
				<div className="border-t border-border px-3 py-2 flex flex-col gap-1">
					{activities.map((activity, idx) => (
						<ActivityRow
							key={idx}
							activity={activity}
							isCurrent={idx === activities.length - 1 && !idle}
						/>
					))}
				</div>
			)}
		</div>
	)
}

interface SemanticActivity {
	label: string
	kind: 'thinking' | 'tool' | 'text' | 'waiting'
}

function extractSemanticActivities(logs: SessionLogResponse[]): SemanticActivity[] {
	const activities: SemanticActivity[] = []

	for (const log of logs) {
		if (log.stream !== 'stdout') continue
		const events = parseSindreLine(log.content, { includeUser: true })
		for (const event of events) {
			const activity = eventToSemanticActivity(event)
			if (!activity) continue
			const last = activities[activities.length - 1]
			if (last && last.label === activity.label) continue
			activities.push(activity)
		}
	}

	return activities.slice(-8)
}

function eventToSemanticActivity(event: SindreEvent): SemanticActivity | null {
	switch (event.kind) {
		case 'thinking':
			return { label: 'Thinking', kind: 'thinking' }
		case 'tool_use':
			return { label: friendlyToolName(event.name), kind: 'tool' }
		case 'text':
			return event.text.trim() ? { label: 'Writing response', kind: 'text' } : null
		case 'result':
			return { label: event.isError ? 'Errored' : 'Waiting for input', kind: 'waiting' }
		default:
			return null
	}
}

function friendlyToolName(name: string): string {
	const lower = name.toLowerCase()
	if (lower.includes('read') || lower.includes('glob') || lower.includes('grep')) return 'Reading files'
	if (lower.includes('write') || lower.includes('edit') || lower.includes('notebook')) return 'Editing files'
	if (lower.includes('bash') || lower.includes('run') || lower.includes('exec')) return 'Running commands'
	if (lower.includes('agent') || lower.includes('spawn')) return 'Running agent'
	if (lower.includes('web') || lower.includes('fetch') || lower.includes('search')) return 'Searching'
	if (lower.includes('todo')) return 'Updating plan'
	return `Using ${name}`
}

function ActivityRow({
	activity,
	isCurrent,
}: {
	activity: SemanticActivity
	isCurrent: boolean
}) {
	return (
		<div className="flex items-center gap-2 text-xs">
			{isCurrent ? (
				<span className="text-primary shrink-0">
					<PulsingDots />
				</span>
			) : (
				<CheckCircle2 size={10} className="shrink-0 text-muted-foreground/50" />
			)}
			<span className={cn(isCurrent ? 'text-foreground' : 'text-muted-foreground')}>
				{activity.label}
			</span>
		</div>
	)
}

function TerminalCard({
	session,
	onOpen,
}: {
	session: SessionResponse
	onOpen: () => void
}) {
	const { data: actor } = useActor(session.actorId)
	const duration = formatDurationBetween(session.startedAt, session.completedAt)
	const status = getTerminalStatus(session.status)

	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex items-center gap-2 w-full text-left rounded-md border border-border bg-secondary/30 px-3 py-2 hover:bg-secondary/50 transition-colors cursor-pointer"
		>
			<status.Icon size={14} className={cn('shrink-0', status.iconClass)} />
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<span className="text-sm font-medium shrink-0">{status.label}</span>
			<span className="text-sm text-muted-foreground shrink-0">· view session logs</span>
			{duration && (
				<span className="ml-auto text-xs text-muted-foreground shrink-0">{duration}</span>
			)}
			<ChevronRight
				size={14}
				className={cn('shrink-0 text-muted-foreground', duration ? '' : 'ml-auto')}
			/>
		</button>
	)
}

function getTerminalStatus(status: SessionResponse['status']): {
	Icon: typeof CheckCircle2
	label: string
	iconClass: string
} {
	if (status === 'failed') return { Icon: XCircle, label: 'Failed', iconClass: 'text-error' }
	if (status === 'timeout') return { Icon: Clock, label: 'Timed out', iconClass: 'text-error' }
	if (status === 'paused')
		return { Icon: Clock, label: 'Paused', iconClass: 'text-muted-foreground' }
	return { Icon: CheckCircle2, label: 'Finished', iconClass: 'text-success' }
}
