import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useSendUserMessage, useSession, useSessionLogs } from '@/hooks/use-sessions'
import type { ActorListItem, SessionLogResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, SendHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/sessions/$sessionId')({
	component: SessionTheater,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const ACCEPTING_STATUSES = new Set([
	'pending',
	'queued',
	'starting',
	'running',
	'waiting_for_input',
])

function SessionTheater() {
	const { sessionId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: session, isLoading } = useSession(sessionId, workspaceId)
	const { data: logs } = useSessionLogs(sessionId, workspaceId)
	const { data: actors } = useActors(workspaceId)
	const sendMessage = useSendUserMessage(sessionId, workspaceId)
	const [draft, setDraft] = useState('')
	const logEndRef = useRef<HTMLDivElement>(null)

	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const a of actors ?? []) map.set(a.id, a)
		return map
	}, [actors])

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new log row
	useEffect(() => {
		logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [logs?.length])

	if (isLoading) {
		return (
			<div className="p-6">
				<Skeleton className="h-8 w-64 mb-4" />
				<Skeleton className="h-96 w-full" />
			</div>
		)
	}
	if (!session) {
		return (
			<div className="p-6">
				<p className="text-sm text-muted-foreground">Session not found.</p>
			</div>
		)
	}

	const accepting = ACCEPTING_STATUSES.has(session.status)
	const sessionActor = actorsById.get(session.actorId)

	const handleSend = () => {
		const trimmed = draft.trim()
		if (!trimmed || !accepting) return
		sendMessage.mutate(trimmed, {
			onSuccess: () => setDraft(''),
		})
	}

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<div className="flex items-center gap-3 px-6 py-3 border-b border-border">
				<Link
					to="/$workspaceId/agents/$agentId"
					params={{ workspaceId, agentId: session.actorId }}
					className="text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft size={16} />
				</Link>
				{sessionActor && <ActorAvatar name={sessionActor.name} type={sessionActor.type} />}
				<div className="flex-1 min-w-0">
					<p className="text-sm font-medium truncate">{sessionActor?.name ?? 'Agent session'}</p>
					<p className="text-xs text-muted-foreground truncate">{session.actionPrompt}</p>
				</div>
				<StatusBadge status={session.status} />
			</div>

			<LogPane logs={logs ?? []} actorsById={actorsById} bottomRef={logEndRef} />

			<div className="border-t border-border p-3">
				<div className="flex items-end gap-2">
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault()
								handleSend()
							}
						}}
						disabled={!accepting}
						placeholder={
							accepting
								? 'Talk to the agent — message is appended on its next turn'
								: `Session is ${session.status}; cannot send messages`
						}
						rows={2}
						className="flex-1 resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-border-focus disabled:opacity-50"
					/>
					<Button
						size="icon"
						variant="ghost"
						className="h-9 w-9 shrink-0"
						disabled={!draft.trim() || !accepting || sendMessage.isPending}
						onClick={handleSend}
					>
						<SendHorizontal size={16} />
					</Button>
				</div>
			</div>
		</div>
	)
}

function LogPane({
	logs,
	actorsById,
	bottomRef,
}: {
	logs: SessionLogResponse[]
	actorsById: Map<string, ActorListItem>
	bottomRef: React.RefObject<HTMLDivElement | null>
}) {
	if (logs.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
				Waiting for the agent to start streaming…
			</div>
		)
	}
	return (
		<div className="flex-1 overflow-y-auto px-6 py-4 font-mono text-xs space-y-1.5 bg-bg-surface">
			{logs.map((log) => (
				<LogRow key={log.id} log={log} actorsById={actorsById} />
			))}
			<div ref={bottomRef} />
		</div>
	)
}

const STREAM_COLOR: Record<string, string> = {
	stdout: 'text-foreground',
	stderr: 'text-error',
	system: 'text-muted-foreground italic',
	user_message: 'text-accent',
}

function LogRow({
	log,
	actorsById,
}: {
	log: SessionLogResponse
	actorsById: Map<string, ActorListItem>
}) {
	// `user_message` rows carry the speaker in `authorActorId` so the content body is
	// treated as pure text (no client-side regex parsing, no spoofing from user input).
	const author = log.authorActorId ? actorsById.get(log.authorActorId) : null
	const prefix = log.stream === 'user_message' ? (author?.name ?? 'Workspace member') : null

	return (
		<div className={cn('whitespace-pre-wrap break-words', STREAM_COLOR[log.stream] ?? '')}>
			{prefix && <span className="font-semibold mr-2">{prefix}:</span>}
			{log.content}
		</div>
	)
}
