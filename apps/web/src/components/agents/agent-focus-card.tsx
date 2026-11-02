import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import { useDuration } from '@/hooks/use-duration'
import { useCreateSession, useStopSession } from '@/hooks/use-sessions'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { toastSessionCreateError } from '@/lib/session-errors'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'

/**
 * The failed-run banner and the Working-now card share one plate: a status dot, a bold
 * line, a muted line, and the actions at the right (below the text on a phone).
 */
function FocusPlate({
	dotClassName,
	label,
	title,
	detail,
	actions,
	role,
	testId,
	tone,
}: {
	dotClassName: string
	/** The small caps line above the title. */
	label?: string
	title: string
	detail?: string | null
	actions: React.ReactNode
	role: 'status' | 'alert'
	testId: string
	/** `live` is the blue tint of the Working-now card; `plain` the soft plate of the failed banner. */
	tone: 'live' | 'plain'
}) {
	return (
		<div
			role={role}
			data-testid={testId}
			className={cn(
				'flex flex-col gap-3 rounded-2xl px-[18px] py-4 leading-tight sm:flex-row sm:items-center',
				tone === 'live' ? 'bg-status-in_progress-bg' : 'bg-muted',
			)}
		>
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<span aria-hidden className={cn('mt-2 size-2 shrink-0 rounded-full', dotClassName)} />
				<div className="flex min-w-0 flex-col gap-0.5">
					{label && (
						<span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
							{label}
						</span>
					)}
					<span className="text-base font-semibold text-foreground sm:truncate">{title}</span>
					{detail && <span className="text-[13px] text-muted-foreground">{detail}</span>}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">{actions}</div>
		</div>
	)
}

/**
 * "<Agent> stopped on its last run": Retry starts the same prompt again (what Restart does on
 * a session row), See log opens that run.
 */
export function AgentFailedBanner({
	agent,
	session,
	onSeeLog,
}: {
	agent: ActorResponse
	/** The newest run, which failed. */
	session: SessionResponse
	onSeeLog: () => void
}) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const createSession = useCreateSession(workspaceId)
	const canWrite = useCanWrite()
	const prompt = session.actionPrompt?.trim() ?? ''

	const retry = () =>
		createSession.mutate(
			{
				actor_id: agent.id,
				action_prompt: prompt,
				...(session.triggerId ? { trigger_id: session.triggerId } : {}),
			},
			{ onError: (err) => toastSessionCreateError(err, navigate, workspaceId) },
		)

	return (
		<FocusPlate
			role="alert"
			testId="agent-failed-banner"
			tone="plain"
			dotClassName="bg-error"
			title={`${agent.name} stopped on its last run`}
			detail="The run ended before it finished."
			actions={
				<>
					{prompt.length > 0 && (
						<ViewerTooltip>
							<Button
								size="sm"
								className="h-[30px] rounded-full px-4 text-[13px] font-semibold"
								onClick={retry}
								disabled={createSession.isPending || !canWrite}
							>
								{createSession.isPending ? 'Retrying…' : 'Retry'}
							</Button>
						</ViewerTooltip>
					)}
					<Button
						size="sm"
						variant="outline"
						className="h-[30px] rounded-full bg-background px-4 text-[13px] font-semibold"
						onClick={onSeeLog}
					>
						See log
					</Button>
				</>
			}
		/>
	)
}

/** The run in progress: Watch opens it, Message goes to the agent's chat, Stop ends it. */
export function AgentWorkingNowCard({
	session,
	title,
	onWatch,
	onMessage,
}: {
	session: SessionResponse
	/** What the run is called: its trigger's name or the first line of its prompt. */
	title: string
	onWatch: () => void
	onMessage: () => void
}) {
	const { workspaceId } = useWorkspace()
	const stop = useStopSession(workspaceId)
	const canWrite = useCanWrite()
	const duration = useDuration(session.startedAt)

	return (
		<FocusPlate
			role="status"
			testId="agent-working-now"
			tone="live"
			dotClassName="bg-success"
			label="Working now"
			title={title}
			detail={duration ? `Running for ${duration}` : null}
			actions={
				<>
					<Button
						size="sm"
						variant="ghost"
						className="h-[30px] px-3 text-sm font-semibold text-brand hover:bg-transparent hover:text-brand-hover"
						onClick={onWatch}
					>
						Watch
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-[30px] px-3 text-sm font-semibold hover:bg-transparent"
						onClick={onMessage}
					>
						Message
					</Button>
					<ViewerTooltip>
						<Button
							size="sm"
							variant="ghost"
							className="h-[30px] px-3 text-sm font-semibold text-muted-foreground hover:bg-transparent hover:text-foreground"
							onClick={() => stop.mutate(session.id)}
							disabled={stop.isPending || !canWrite}
						>
							{stop.isPending ? 'Stopping…' : 'Stop'}
						</Button>
					</ViewerTooltip>
				</>
			}
		/>
	)
}
