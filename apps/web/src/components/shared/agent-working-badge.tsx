import {
	type ActivityStep,
	getActivityLog,
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLogs } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import {
	AlertTriangle,
	ChevronDown,
	MessageSquare,
	PauseCircle,
	Sparkles,
	User,
	Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActorAvatar } from './actor-avatar'

interface AgentWorkingBadgeProps {
	sessionId: string
	workspaceId: string
	variant?: 'compact' | 'banner'
	/**
	 * Banner-only. Renders as a chain-of-thought-style dropdown: the header
	 * stays the live one-line preview, and expanding it reveals every step
	 * (tool calls, thinking, text) the agent has taken so far this turn.
	 * Auto-expands while the agent is actively working and auto-collapses
	 * once it goes idle, unless the user has toggled it manually.
	 */
	expandable?: boolean
}

export function AgentWorkingBadge({
	sessionId,
	workspaceId,
	variant = 'compact',
	expandable = false,
}: AgentWorkingBadgeProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const { data: actor } = useActor(session?.actorId ?? '')
	const { data: logs } = useSessionLogs(sessionId, workspaceId, true, { live: true })
	const duration = useDuration(session?.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const steps = useMemo(() => getActivityLog(logs ?? []), [logs])
	const label = idle ? (actor?.name ?? 'Agent') : (actor?.name ?? 'Agent working')

	const [manuallyToggled, setManuallyToggled] = useState(false)
	const [open, setOpen] = useState(!idle)
	useEffect(() => {
		if (manuallyToggled) return
		setOpen(!idle)
	}, [idle, manuallyToggled])

	const stepsRef = useRef<HTMLDivElement | null>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: pin scroll to bottom whenever a new step arrives while open
	useEffect(() => {
		if (!open) return
		const el = stepsRef.current
		if (!el) return
		el.scrollTop = el.scrollHeight
	}, [steps.length, open])

	const Icon = idle ? (
		<PauseCircle size={14} className="shrink-0 text-muted-foreground" />
	) : (
		<Spinner />
	)

	if (variant === 'banner') {
		const header = (
			<div className="flex items-center gap-2.5">
				{Icon}
				{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
				<span className="text-sm font-medium truncate">{label}</span>
				{preview && (
					<>
						<span className="text-muted-foreground">·</span>
						<span className="text-sm text-muted-foreground truncate min-w-0">{preview}</span>
					</>
				)}
				{duration && (
					<span
						className={cn('text-xs text-muted-foreground shrink-0', expandable ? '' : 'ml-auto')}
					>
						{duration}
					</span>
				)}
				{expandable && (
					<ChevronDown
						size={14}
						className={cn(
							'ml-auto shrink-0 text-muted-foreground transition-transform',
							open && 'rotate-180',
						)}
					/>
				)}
			</div>
		)

		if (!expandable) {
			return (
				<div className="rounded-md border border-border bg-secondary/50 px-3 py-2 mb-4 min-w-0">
					{header}
					{session?.currentActivity && (
						<div className="flex items-center gap-1.5 mt-1 pl-6">
							<span className="size-1.5 rounded-full bg-primary animate-pulse shrink-0" />
							<span className="text-xs text-muted-foreground truncate">
								{session.currentActivity}
							</span>
						</div>
					)}
				</div>
			)
		}

		return (
			<Collapsible
				open={open}
				onOpenChange={(next) => {
					setManuallyToggled(true)
					setOpen(next)
				}}
				className="rounded-md border border-border bg-secondary/50 px-3 py-2 min-w-0"
			>
				<CollapsibleTrigger
					className="w-full cursor-pointer text-left"
					aria-label="Toggle agent activity"
				>
					{header}
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div
						ref={stepsRef}
						className="mt-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto border-t border-border pt-2 pl-6"
					>
						{steps.length === 0 ? (
							<span className="text-xs text-muted-foreground">Starting…</span>
						) : (
							steps.map((step) => (
								<div
									key={step.id}
									className="flex items-start gap-1.5 text-xs text-muted-foreground"
								>
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

	return (
		<Badge variant="secondary" className="gap-1.5 max-w-[200px] sm:max-w-[280px]">
			{Icon}
			<span className="truncate">
				{label}
				{preview && <span className="text-muted-foreground"> · {preview}</span>}
			</span>
			{duration && <span className="text-muted-foreground shrink-0"> · {duration}</span>}
		</Badge>
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
