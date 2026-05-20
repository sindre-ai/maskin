import { SessionDetailPanel } from '@/components/agents/session-detail-panel'
import { getLatestActivityPreview } from '@/components/agents/session-log-transcript'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { StreamingIndicator } from '@/components/shared/streaming-indicator'
import { useActor } from '@/hooks/use-actors'
import { useSessionLogs } from '@/hooks/use-sessions'
import type { SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDurationBetween } from '@/lib/format-duration'
import { CheckCircle2, ChevronRight, Clock, XCircle } from 'lucide-react'
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
				<TerminalCard
					session={session}
					workspaceId={workspaceId}
					onOpen={() => setPanelOpen(true)}
				/>
			) : (
				<button
					type="button"
					onClick={() => setPanelOpen(true)}
					className="block w-full bg-transparent border-0 p-0 text-left cursor-pointer"
				>
					<StreamingIndicator sessionId={session.id} workspaceId={workspaceId} />
				</button>
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

function TerminalCard({
	session,
	workspaceId,
	onOpen,
}: {
	session: SessionResponse
	workspaceId: string
	onOpen: () => void
}) {
	const { data: actor } = useActor(session.actorId)
	const { data: logs } = useSessionLogs(session.id, workspaceId, true)
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
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
			{preview && (
				<>
					<span className="text-muted-foreground shrink-0">·</span>
					<span className="text-sm text-muted-foreground truncate min-w-0">{preview}</span>
				</>
			)}
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

function getTerminalStatus(status: string): {
	Icon: typeof CheckCircle2
	label: string
	iconClass: string
} {
	if (status === 'completed')
		return { Icon: CheckCircle2, label: 'Finished', iconClass: 'text-success' }
	if (status === 'failed') return { Icon: XCircle, label: 'Failed', iconClass: 'text-error' }
	if (status === 'timeout') return { Icon: Clock, label: 'Timed out', iconClass: 'text-error' }
	if (status === 'paused')
		return { Icon: Clock, label: 'Paused', iconClass: 'text-muted-foreground' }
	return { Icon: CheckCircle2, label: status, iconClass: 'text-muted-foreground' }
}
