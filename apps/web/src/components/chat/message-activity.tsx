import type { ActivityStep } from '@/components/agents/session-log-transcript'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { useActor } from '@/hooks/use-actors'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { useStopSession } from '@/hooks/use-sessions'
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
				<ChevronDown
					size={12}
					className={cn('shrink-0 transition-transform', open && 'rotate-180')}
				/>
			</CollapsibleTrigger>
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
