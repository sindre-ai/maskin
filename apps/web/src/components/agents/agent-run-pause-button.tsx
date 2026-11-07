import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { useCanWrite } from '@/hooks/use-can-write'
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
	density = 'default',
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
	/** 'nav' matches the top nav's 30px control scale (Search, New). */
	density?: 'default' | 'nav'
}) {
	// Starting and pausing an agent are writes; a viewer sees the button switched off.
	const canWrite = useCanWrite()
	// The nav row is built on a 30px scale (NewMenu's
	// h-[30px]) rather than shadcn's sm (h-9/36px), so a nav-density button opts
	// out of the sm height entirely. Everywhere else keeps the 44px touch floor.
	const className = cn(
		density === 'nav'
			? 'h-8 gap-1.5 rounded-full px-3.5 text-[13px] font-semibold'
			: 'min-h-[44px]',
		fullWidth && 'w-full',
		// One switch, not an action and its undo: `warning` draws both states
		// identically so the control's appearance reports the agent's state
		// rather than the severity of the click.
		tone === 'warning' &&
			'border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
	)

	if (isActive) {
		return (
			<ViewerTooltip className={fullWidth ? 'flex w-full' : 'inline-flex'}>
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
					disabled={isPausePending || !canWrite}
				>
					{density !== 'nav' && <PauseCircle size={14} aria-hidden="true" />}
					{isPausePending ? 'Pausing…' : pauseLabel}
				</Button>
			</ViewerTooltip>
		)
	}

	return (
		<ViewerTooltip className={fullWidth ? 'flex w-full' : 'inline-flex'}>
			<Button
				type="button"
				variant={tone === 'warning' ? 'outline' : 'default'}
				size="sm"
				className={className}
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					onRun()
				}}
				disabled={isRunPending || !canWrite}
			>
				{density !== 'nav' && <Play size={14} aria-hidden="true" />}
				{isRunPending ? 'Starting…' : runLabel}
			</Button>
		</ViewerTooltip>
	)
}
