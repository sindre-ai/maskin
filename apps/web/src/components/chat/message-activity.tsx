import type { ActivityStep } from '@/components/agents/session-log-transcript'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useActor } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useStopSession } from '@/hooks/use-sessions'
import { secondsSince, trackChatStopClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { plainActivityLine } from '@/lib/plain-activity'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'

interface MessageActivityProps {
	workspaceId: string
	turn: MessageTurnActivity
	/**
	 * `block` — a standalone row with its own avatar, sitting in the transcript
	 * under the message that triggered it. This is the live "…is writing a
	 * reply" indicator (mockup 450–476).
	 * `inline` — a one-line, muted summary rendered *inside* the agent's own
	 * message, directly under its name, for a turn that has already finished.
	 */
	layout?: 'block' | 'inline'
}

/**
 * One agent's chain-of-thought for a single conversation turn, anchored to the
 * message it belongs to rather than pooled at the bottom of the thread.
 *
 * A live turn is drawn closed: the agent's name, three pulsing dots, one plain
 * line for what it is doing now, and an elapsed readout. A small "Show steps"
 * toggle opens the steps it has taken, with the current one picked out in ink
 * and the rest greyed behind it. A finished turn collapses to a single muted
 * "Show work" line the reader can open if they want the trace.
 */
export function MessageActivity({ workspaceId, turn, layout = 'block' }: MessageActivityProps) {
	const { data: actor } = useActor(turn.actorId)
	const stopSession = useStopSession(workspaceId)
	const canWrite = useCanWrite()
	// Only a live turn needs its session row: `startedAt` is what turns the
	// indicator's elapsed readout into a real number rather than "since this
	// tab happened to open" (mockup 7816).
	const { data: session } = useSession(turn.inProgress ? turn.sessionId : null, workspaceId)
	const elapsed = useDuration(turn.inProgress ? session?.startedAt : null)

	if (!turn.inProgress && !turn.failed && turn.steps.length === 0) return null

	const name = actor?.name ?? 'Agent'

	if (turn.inProgress) {
		return (
			<div className="flex items-start gap-[11px]" data-testid="message-activity-live">
				<ActorAvatar
					id={turn.actorId}
					name={name}
					type={actor?.type ?? 'agent'}
					size="md"
					className="shrink-0"
				/>
				<div className="min-w-0 flex-1 md:max-w-[660px]">
					<div className="flex items-center gap-2">
						<span className="shrink-0 text-[12.5px] font-bold text-foreground">{name}</span>
						<TypingDots />
						<span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
							{turn.steps.length === 0 ? 'Starting…' : plainActivityLine(turn.steps)}
						</span>
						{elapsed ? (
							<span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
								{elapsed}
							</span>
						) : null}
					</div>
					<LiveSteps turn={turn} />
					{/* While the session is still booting (pending/starting/queued)
					    there is no container or agent-server to stop yet — POST
					    /sessions/:id/stop would 400 on `no container` and the
					    mutation would silently fail (see session-manager.ts's
					    stopSession). Hide the control until the process is live. */}
					{turn.starting ? null : (
						<ViewerTooltip className="mt-2 inline-flex">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-0 text-[10.5px] font-bold text-muted-foreground hover:bg-transparent hover:text-foreground"
								onClick={() => {
									trackChatStopClicked({
										session_id: turn.sessionId,
										seconds_running: secondsSince(session?.startedAt),
									})
									stopSession.mutate(turn.sessionId)
								}}
								disabled={stopSession.isPending || !canWrite}
							>
								Stop
							</Button>
						</ViewerTooltip>
					)}
				</div>
			</div>
		)
	}

	return <FinishedTurn turn={turn} name={name} indented={layout === 'block'} />
}

/** The live turn's step list, closed until the reader asks for it. */
function LiveSteps({ turn }: { turn: MessageTurnActivity }) {
	const [open, setOpen] = useState(false)
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="mt-1 flex cursor-pointer items-center gap-1 py-px text-[10.5px] text-muted-foreground hover:opacity-65">
				<span>{open ? 'Hide steps' : 'Show steps'}</span>
				<ChevronDown
					size={11}
					className={cn('shrink-0 text-border-strong transition-transform', open && 'rotate-180')}
					aria-hidden
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<StepList turn={turn} className="mt-[7px]" />
			</CollapsibleContent>
		</Collapsible>
	)
}

/**
 * A completed (or failed) turn: a quiet "show work" line the reader can open
 * into the trace (mockup 413–430). Closed, it reads "Show work" —
 * the message beside it already carries the name, and the last tool name says
 * nothing a reader can use.
 */
function FinishedTurn({
	turn,
	name,
	indented,
}: {
	turn: MessageTurnActivity
	name: string
	indented: boolean
}) {
	const [manuallyToggled, setManuallyToggled] = useState(false)
	const [open, setOpen] = useState(turn.failed === true)
	useEffect(() => {
		if (manuallyToggled) return
		setOpen(turn.failed === true)
	}, [turn.failed, manuallyToggled])

	const closedLabel = turn.failed ? `${name} failed to start` : 'Show work'

	return (
		<Collapsible
			open={open}
			onOpenChange={(next) => {
				setManuallyToggled(true)
				setOpen(next)
			}}
			className={cn('min-w-0', indented && 'pl-[39px]')}
			data-testid="message-activity-done"
		>
			<CollapsibleTrigger
				className={cn(
					'flex w-full max-w-full cursor-pointer items-center gap-1.5 py-px text-left text-[11px] hover:opacity-65',
					turn.failed ? 'text-error' : 'text-muted-foreground',
				)}
				aria-label={`Toggle ${name} activity`}
			>
				{turn.failed ? <AlertTriangle size={12} className="shrink-0" /> : null}
				<span className="min-w-0 truncate" role={turn.failed ? 'alert' : undefined}>
					{/* A failure keeps saying so while open — swapping it for "Hide
					    work" would hide the only notice that the turn broke. */}
					{open && !turn.failed ? 'Hide work' : closedLabel}
				</span>
				<ChevronDown
					size={11}
					className={cn('shrink-0 text-border-strong transition-transform', open && 'rotate-180')}
					aria-hidden
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				{turn.steps.length === 0 ? (
					<p
						className={cn(
							'mt-1.5 text-[11.5px]',
							turn.failed ? 'text-error' : 'text-muted-foreground',
						)}
					>
						{turn.failed ? 'The session could not be started.' : 'No steps were recorded.'}
					</p>
				) : (
					<StepList turn={turn} className="mt-1.5 ml-0.5 max-h-56 overflow-y-auto" />
				)}
			</CollapsibleContent>
		</Collapsible>
	)
}

/**
 * How a step's kind is drawn in the trace (mockup 6141–6146). The label column
 * is what makes the trace skimmable — you can see at a glance that an agent
 * read four things and wrote one, without reading a word of the detail.
 */
const STEP_KIND: Record<
	ActivityStep['kind'],
	{ label: string; dot: string; round: boolean; text: string; labelText: string }
> = {
	thinking: {
		label: 'THOUGHT',
		dot: 'bg-border',
		round: true,
		text: 'text-muted-foreground/70',
		labelText: 'text-muted-foreground/70',
	},
	tool_use: {
		label: 'READ',
		dot: 'bg-border-strong',
		round: false,
		text: 'text-foreground/70',
		labelText: 'text-muted-foreground',
	},
	text: {
		label: 'WROTE',
		dot: 'bg-muted-foreground',
		round: false,
		text: 'text-foreground',
		labelText: 'text-foreground/70',
	},
	user: {
		label: 'READ',
		dot: 'bg-border-strong',
		round: false,
		text: 'text-foreground/70',
		labelText: 'text-muted-foreground',
	},
	error: {
		label: 'FAILED',
		dot: 'bg-warning',
		round: true,
		text: 'text-warning',
		labelText: 'text-warning',
	},
}

/**
 * The steps themselves, hung off a left rule with a kind column. While the
 * turn is live the newest step is the one the agent is on, so it holds ink and
 * a solid marker while everything above it recedes (mockup 7817–7821).
 */
function StepList({ turn, className }: { turn: MessageTurnActivity; className?: string }) {
	if (turn.steps.length === 0) {
		return turn.inProgress ? (
			<p className={cn('text-[11.5px] text-muted-foreground', className)}>Starting…</p>
		) : null
	}
	return (
		<ul
			className={cn('flex list-none flex-col border-l border-border-subtle pl-[15px]', className)}
			aria-label="Agent activity"
		>
			{turn.steps.map((step, index) => {
				const isCurrent = turn.inProgress && index === turn.steps.length - 1
				const kind = STEP_KIND[step.kind] ?? STEP_KIND.tool_use
				return (
					<li key={step.id} className="relative flex items-baseline gap-[9px] py-[3px]">
						<span
							aria-hidden
							className={cn(
								'absolute top-[7px] -left-[19px] size-[5px]',
								kind.round ? 'rounded-full' : 'rounded-[1px]',
								isCurrent ? 'bg-foreground' : kind.dot,
							)}
						/>
						<span
							className={cn(
								'w-12 shrink-0 pt-px font-mono text-[8px] font-bold tracking-[0.09em]',
								kind.labelText,
							)}
						>
							{kind.label}
						</span>
						<span
							className={cn(
								'min-w-0 text-[11.5px] leading-[1.45] text-pretty',
								isCurrent ? 'text-foreground' : kind.text,
							)}
						>
							{step.text}
						</span>
					</li>
				)
			})}
		</ul>
	)
}

/** Three staggered dots — the "still going" tell that sits before the verb. */
function TypingDots() {
	return (
		<span className="inline-flex shrink-0 items-center gap-[3px]" aria-hidden>
			<span className="size-[5px] animate-pulse rounded-full bg-muted-foreground" />
			<span className="size-[5px] animate-pulse rounded-full bg-muted-foreground [animation-delay:160ms]" />
			<span className="size-[5px] animate-pulse rounded-full bg-muted-foreground [animation-delay:320ms]" />
		</span>
	)
}
