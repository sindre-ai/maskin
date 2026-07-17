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
	fullWidth = false,
	disabled = false,
	disabledReason,
}: {
	isActive: boolean
	onRun: () => void
	onPause: () => void
	isRunPending?: boolean
	isPausePending?: boolean
	runLabel?: string
	fullWidth?: boolean
	disabled?: boolean
	disabledReason?: string
}) {
	const className = cn('min-h-[44px]', fullWidth && 'w-full')

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
				{isPausePending ? 'Pausing…' : 'Pause'}
			</Button>
		)
	}

	return (
		<Button
			type="button"
			size="sm"
			className={className}
			onClick={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onRun()
			}}
			disabled={isRunPending || disabled}
			title={disabled ? disabledReason : undefined}
		>
			<Play size={14} aria-hidden="true" />
			{isRunPending ? 'Starting…' : runLabel}
		</Button>
	)
}
