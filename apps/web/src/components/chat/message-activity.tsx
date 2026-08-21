import type { ActivityStep } from '@/components/agents/session-log-transcript'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { useActor } from '@/hooks/use-actors'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { cn } from '@/lib/cn'
import { AlertTriangle, ChevronDown, MessageSquare, Sparkles, User, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface MessageActivityProps {
	turn: MessageTurnActivity
}

/**
 * One agent's chain-of-thought dropdown for a single conversation turn —
 * anchored right under the message that triggered it, instead of one
 * dropdown at the bottom of the thread mixing every turn together. Live
 * turns auto-expand and keep streaming in new steps; finished turns default
 * to collapsed unless the user has toggled one open manually.
 */
export function MessageActivity({ turn }: MessageActivityProps) {
	const { data: actor } = useActor(turn.actorId)
	const [manuallyToggled, setManuallyToggled] = useState(false)
	const attention = turn.failed === true || turn.interrupted === true
	const [open, setOpen] = useState(turn.inProgress || attention)
	useEffect(() => {
		if (manuallyToggled) return
		setOpen(turn.inProgress || attention)
	}, [turn.inProgress, attention, manuallyToggled])

	const stepsRef = useRef<HTMLDivElement | null>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: pin scroll to bottom whenever a new step arrives while open
	useEffect(() => {
		if (!open) return
		const el = stepsRef.current
		if (!el) return
		el.scrollTop = el.scrollHeight
	}, [turn.steps.length, open])

	if (!turn.inProgress && !attention && turn.steps.length === 0) return null

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
				{attention && <AlertTriangle size={12} className="shrink-0" />}
				<span role={attention ? 'alert' : undefined}>
					{turn.failed
						? `${name} failed to start`
						: turn.interrupted
							? `${name} stopped before finishing`
							: turn.inProgress
								? `${name} is working…`
								: name}
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
						turn.steps.map((step) => (
							<div key={step.id} className="flex items-start gap-1.5">
								<ActivityStepIcon kind={step.kind} />
								<span className="truncate">{step.text}</span>
							</div>
						))
					)}
				</div>
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
