import type { ActivityStep } from '@/components/agents/session-log-transcript'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { useActor } from '@/hooks/use-actors'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useStopSession } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	MessageSquare,
	Sparkles,
	User,
	Wrench,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface MessageActivityProps {
	workspaceId: string
	turn: MessageTurnActivity
}

/**
 * One agent's chain-of-thought dropdown for a single conversation turn —
 * anchored right under the message that triggered it, instead of one
 * dropdown at the bottom of the thread mixing every turn together. Live
 * turns auto-expand and keep streaming in new steps; finished turns default
 * to collapsed unless the user has toggled one open manually.
 */
export function MessageActivity({ workspaceId, turn }: MessageActivityProps) {
	const { data: actor } = useActor(turn.actorId)
	const stopSession = useStopSession(workspaceId)
	// Only a live turn needs its session row: `startedAt` is what turns the
	// indicator's elapsed readout into a real number rather than "since this
	// tab happened to open" (mockup 710).
	const { data: session } = useSession(turn.inProgress ? turn.sessionId : null, workspaceId)
	const elapsed = useDuration(turn.inProgress ? session?.startedAt : null)
	// What the agent is reading right now, straight off its own tool calls —
	// the mockup's source pills (720–724). Deduped, newest first, capped so a
	// long tool run can't push the composer off screen.
	const sources = turn.inProgress ? toolSources(turn.steps) : []
	const [manuallyToggled, setManuallyToggled] = useState(false)
	const [open, setOpen] = useState(turn.inProgress || turn.failed === true)
	useEffect(() => {
		if (manuallyToggled) return
		setOpen(turn.inProgress || turn.failed === true)
	}, [turn.inProgress, turn.failed, manuallyToggled])

	const stepsRef = useRef<HTMLDivElement | null>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: pin scroll to bottom whenever a new step arrives while open
	useEffect(() => {
		if (!open) return
		const el = stepsRef.current
		if (!el) return
		el.scrollTop = el.scrollHeight
	}, [turn.steps.length, open])

	if (!turn.inProgress && !turn.failed && turn.steps.length === 0) return null

	const name = actor?.name ?? 'Agent'

	return (
		<Collapsible
			open={open}
			onOpenChange={(next) => {
				setManuallyToggled(true)
				setOpen(next)
			}}
			className="min-w-0 pl-8"
		>
			<CollapsibleTrigger
				className={cn(
					'flex w-fit cursor-pointer items-center gap-1.5 text-xs',
					turn.failed ? 'text-error' : 'text-muted-foreground',
				)}
				aria-label={`Toggle ${name} activity`}
			>
				{turn.inProgress && <Spinner />}
				{turn.failed && <AlertTriangle size={12} className="shrink-0" />}
				<span role={turn.failed ? 'alert' : undefined}>
					{turn.failed ? `${name} failed to start` : turn.inProgress ? `${name} is working…` : name}
				</span>
				{elapsed ? (
					<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
						{elapsed}
					</span>
				) : null}
				<ChevronDown
					size={12}
					className={cn('shrink-0 transition-transform', open && 'rotate-180')}
				/>
			</CollapsibleTrigger>
			{/* Collapsed, the pills are the only view of what the agent is reading;
			    expanded, the step list below already says it — so they never
			    duplicate the same strings on screen (mockup 720–724). */}
			{!open && sources.length > 0 ? (
				<ul aria-label="Sources being read" className="mt-1 flex list-none flex-wrap gap-1 p-0">
					{sources.map((source) => (
						<li
							key={source}
							className="inline-flex h-5 max-w-[14rem] items-center truncate rounded-full border border-border bg-card px-2 text-[10.5px] font-semibold text-muted-foreground"
						>
							{source}
						</li>
					))}
				</ul>
			) : null}
			<CollapsibleContent>
				<div
					ref={stepsRef}
					className={cn(
						'mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs',
						turn.failed ? 'text-error' : 'text-muted-foreground',
					)}
				>
					{turn.steps.length === 0 ? (
						<span>{turn.failed ? 'The session could not be started.' : 'Starting…'}</span>
					) : (
						turn.steps.map((step, index) => (
							<div key={step.id} className="flex items-start gap-1.5">
								{/* A live turn marks everything above the newest step as done
								    and points at the step it is on (mockup 715); a finished
								    turn keeps the per-kind icon, which says more. */}
								{turn.inProgress ? (
									index === turn.steps.length - 1 ? (
										<ChevronRight size={12} className="mt-0.5 shrink-0" aria-hidden />
									) : (
										<Check size={12} className="mt-0.5 shrink-0" aria-hidden />
									)
								) : (
									<ActivityStepIcon kind={step.kind} />
								)}
								<span className="truncate">{step.text}</span>
							</div>
						))
					)}
				</div>
				{turn.inProgress ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="mt-1 h-6 px-1.5 text-[10.5px] font-bold text-muted-foreground hover:text-foreground"
						onClick={() => stopSession.mutate(turn.sessionId)}
						disabled={stopSession.isPending}
					>
						Stop
					</Button>
				) : null}
			</CollapsibleContent>
		</Collapsible>
	)
}

const MAX_SOURCE_PILLS = 3

// The distinct tool calls a live turn has made, newest first — one pill per
// source the agent is reading.
export function toolSources(steps: MessageTurnActivity['steps']): string[] {
	const seen: string[] = []
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i]
		if (step.kind !== 'tool_use') continue
		const label = step.text.trim()
		if (label.length === 0 || seen.includes(label)) continue
		seen.push(label)
		if (seen.length === MAX_SOURCE_PILLS) break
	}
	return seen
}

function ActivityStepIcon({ kind }: { kind: ActivityStep['kind'] }) {
	const iconProps = { size: 12, className: 'mt-0.5 shrink-0' }
	switch (kind) {
		case 'tool_use':
			return <Wrench {...iconProps} />
		case 'thinking':
			return <Sparkles {...iconProps} />
		case 'user':
			return <User {...iconProps} />
		case 'error':
			return <AlertTriangle {...iconProps} />
		default:
			return <MessageSquare {...iconProps} />
	}
}
