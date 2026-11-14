import { cn } from '@/lib/cn'
import type { PlanUsageTone } from '@/lib/plan-usage'

const FILL: Record<PlanUsageTone, string> = {
	primary: 'bg-primary',
	warning: 'bg-warning',
	error: 'bg-error',
}

/**
 * A thin progress bar for "N% of plan used". Colour is never the only signal:
 * the number is always written next to it by the caller.
 */
export function PlanMeter({
	percent,
	tone,
	label = 'Plan usage',
	className,
}: {
	percent: number
	tone: PlanUsageTone
	label?: string
	className?: string
}) {
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuenow={percent}
			aria-valuemin={0}
			aria-valuemax={100}
			tabIndex={-1}
			className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
		>
			<div
				className={cn('h-full rounded-full transition-[width] duration-250 ease-brand', FILL[tone])}
				style={{ width: `${percent}%` }}
			/>
		</div>
	)
}
