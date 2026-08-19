import { cn } from '@/lib/cn'
import { PauseCircle, Play } from 'lucide-react'
import { Button } from '../ui/button'

export function AgentRunPauseButton({
	isActive,
	onRun,
	onPause,
	isRunPending = false,
	isPausePending = false,
	runLabel = 'Run',
	pauseLabel = 'Pause',
	tone = 'default',
	fullWidth = false,
}: {
	isActive: boolean
	onRun: () => void
	onPause: () => void
	isRunPending?: boolean
	isPausePending?: boolean
	runLabel?: string
	pauseLabel?: string
	/** `warning` draws both states as one bordered amber control — how v2 renders
	 *  the agent-level Disable/Enable toggle in the detail bar (mockup 2313), where
	 *  the two states are one switch rather than a primary action and its undo. */
	tone?: 'default' | 'warning'
	fullWidth?: boolean
}) {
	const isWarning = tone === 'warning'
	const className = cn(
		'min-h-[44px]',
		isWarning && 'text-warning hover:bg-warning/5 hover:text-warning',
		fullWidth && 'w-full',
	)

	if (isActive) {
		return (
			<Button
				type="button"
				variant="outline"
				size="sm"
				className={className}
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					onPause()
				}}
				disabled={isPausePending}
			>
				<PauseCircle size={14} aria-hidden="true" />
				{isPausePending ? 'Pausing…' : pauseLabel}
			</Button>
		)
	}

	return (
		<Button
			type="button"
			variant={isWarning ? 'outline' : 'default'}
			size="sm"
			className={className}
			onClick={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onRun()
			}}
			disabled={isRunPending}
		>
			<Play size={14} aria-hidden="true" />
			{isRunPending ? 'Starting…' : runLabel}
		</Button>
	)
}
