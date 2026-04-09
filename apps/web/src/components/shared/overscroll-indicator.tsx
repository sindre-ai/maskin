import { cn } from '@/lib/cn'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface OverscrollIndicatorProps {
	direction: 'next' | 'prev'
	progress: number
	targetLabel: string
}

export function OverscrollIndicator({
	direction,
	progress,
	targetLabel,
}: OverscrollIndicatorProps) {
	const isNext = direction === 'next'
	const Icon = isNext ? ChevronDown : ChevronUp
	const visible = progress > 0

	return (
		<div
			className={cn(
				'flex items-center justify-center py-4 transition-all duration-200',
				visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
			)}
		>
			<div className="relative overflow-hidden rounded-full border border-border bg-muted/50 px-4 py-2">
				<div
					className="absolute inset-0 bg-muted transition-all duration-100"
					style={{ width: `${progress * 100}%` }}
				/>
				<div className="relative flex items-center gap-1.5 text-sm text-muted-foreground">
					<Icon size={14} className="animate-bounce" />
					<span>
						Keep scrolling for <span className="font-medium text-foreground">{targetLabel}</span>
					</span>
				</div>
			</div>
		</div>
	)
}
