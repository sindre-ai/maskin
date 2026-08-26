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
	density = 'default',
}: {
	isActive: boolean
	onRun: () => void
	onPause: () => void
	isRunPending?: boolean
	isPausePending?: boolean
	runLabel?: string
	fullWidth?: boolean
	/** 'nav' matches the top nav's 30px control scale (Search, New). */
	density?: 'default' | 'nav'
}) {
	// The nav row is built on a 30px scale (NavSearch's size-[30px], NewMenu's
	// h-[30px]) rather than shadcn's sm (h-9/36px), so a nav-density button opts
	// out of the sm height entirely. Everywhere else keeps the 44px touch floor.
	const className = cn(
		density === 'nav' ? 'h-[30px] gap-1.5 rounded-lg px-2.5 text-xs font-semibold' : 'min-h-[44px]',
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
			disabled={isRunPending}
		>
			<Play size={14} aria-hidden="true" />
			{isRunPending ? 'Starting…' : runLabel}
		</Button>
	)
}
