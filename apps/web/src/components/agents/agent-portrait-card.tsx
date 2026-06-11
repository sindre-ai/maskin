import { useAgentPause, useAgentRun } from '@/hooks/use-actors'
import type { ActorResponse, AgentState } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Pause, Play } from 'lucide-react'
import type { ReactNode } from 'react'

type Size = 'sm' | 'md' | 'lg'

export interface AgentPortraitCardProps {
	agent: ActorResponse
	size?: Size
	onRun?: () => void
	onPause?: () => void
}

const ringSize: Record<Size, string> = {
	sm: 'h-9 w-9',
	md: 'h-12 w-12',
	lg: 'h-16 w-16',
}

const avatarTextSize: Record<Size, string> = {
	sm: 'text-xs',
	md: 'text-sm',
	lg: 'text-base',
}

const nameSize: Record<Size, string> = {
	sm: 'text-xs font-medium',
	md: 'text-sm font-medium',
	lg: 'text-base font-semibold',
}

function ringColorClass(state: AgentState, animated: boolean): string {
	const base =
		state === 'running'
			? 'bg-success'
			: state === 'paused'
				? 'bg-warning'
				: state === 'failed'
					? 'bg-error'
					: 'bg-border'
	return animated ? `${base} animate-pulse` : base
}

function avatarColorClass(state: AgentState): string {
	if (state === 'running') return 'bg-success/15 text-success'
	if (state === 'paused') return 'bg-warning/15 text-warning'
	if (state === 'failed') return 'bg-error/15 text-error'
	return 'bg-muted text-muted-foreground'
}

function MomentumRing({
	state,
	size,
	children,
}: {
	state: AgentState
	size: Size
	children: ReactNode
}) {
	const padding = size === 'sm' ? 'p-0.5' : size === 'md' ? 'p-[3px]' : 'p-1'
	return (
		<div
			className={cn(
				'rounded-full flex-shrink-0',
				padding,
				ringSize[size],
				ringColorClass(state, state === 'running'),
			)}
		>
			{children}
		</div>
	)
}

function AgentAvatar({
	agent,
	state,
	size,
}: { agent: ActorResponse; state: AgentState; size: Size }) {
	return (
		<div className="rounded-full w-full h-full bg-background p-px">
			<span
				className={cn(
					'rounded-full flex items-center justify-center w-full h-full font-semibold',
					avatarTextSize[size],
					avatarColorClass(state),
				)}
				title={agent.name}
			>
				{agent.name.charAt(0).toUpperCase()}
			</span>
		</div>
	)
}

export function AgentPortraitCard({ agent, size = 'md', onRun, onPause }: AgentPortraitCardProps) {
	const { workspaceId } = useWorkspace()
	const runMutation = useAgentRun(workspaceId)
	const pauseMutation = useAgentPause(workspaceId)

	const state = agent.agentState

	const handleRun = () => {
		runMutation.mutate({ id: agent.id }, { onSuccess: onRun })
	}

	const handlePause = () => {
		pauseMutation.mutate(agent.id, { onSuccess: onPause })
	}

	const showPlay = onRun !== undefined && (state === 'idle' || state === 'paused')
	const showPause = onPause !== undefined && state === 'running'
	const isActing = runMutation.isPending || pauseMutation.isPending

	return (
		<div className={cn('flex items-center gap-3 min-w-0', size === 'lg' && 'gap-4')}>
			<MomentumRing state={state} size={size}>
				<AgentAvatar agent={agent} state={state} size={size} />
			</MomentumRing>

			<div className="flex flex-col min-w-0 flex-1">
				<span className={cn('truncate', nameSize[size])}>{agent.name}</span>
				{agent.description && (
					<span className="truncate text-xs text-muted-foreground leading-snug mt-0.5">
						{agent.description}
					</span>
				)}
			</div>

			{(showPlay || showPause) && (
				<button
					type="button"
					disabled={isActing}
					onClick={showPause ? handlePause : handleRun}
					className={cn(
						'flex-shrink-0 flex items-center justify-center rounded-full transition-colors',
						'disabled:opacity-50 disabled:pointer-events-none',
						size === 'sm' ? 'h-6 w-6' : size === 'md' ? 'h-7 w-7' : 'h-8 w-8',
						showPause ? 'text-warning hover:bg-warning/10' : 'text-success hover:bg-success/10',
					)}
					aria-label={showPause ? 'Pause agent' : 'Run agent'}
				>
					{showPause ? (
						<Pause className={cn(size === 'sm' ? 'h-3 w-3' : 'h-4 w-4')} />
					) : (
						<Play className={cn(size === 'sm' ? 'h-3 w-3' : 'h-4 w-4')} />
					)}
				</button>
			)}
		</div>
	)
}
