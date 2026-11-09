import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

/** Shown in place of one block of the loop page when its calls failed or are too slow. */
export function LoopBlockError({
	message,
	onRetry,
	className,
}: {
	message: string
	onRetry: () => void
	className?: string
}) {
	return (
		<div
			role="alert"
			data-testid="loop-block-error"
			className={cn(
				'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted px-3 py-2',
				className,
			)}
		>
			<p className="text-xs text-muted-foreground">{message}</p>
			<Button variant="outline" size="sm" onClick={onRetry} className="h-7 text-xs">
				Try again
			</Button>
		</div>
	)
}
