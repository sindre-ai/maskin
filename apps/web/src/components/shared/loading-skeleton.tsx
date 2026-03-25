import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
	return <div className={cn('animate-pulse rounded bg-muted', className)} />
}

export function CardSkeleton() {
	return (
		<div className="rounded-lg border border-border bg-card p-4 space-y-3">
			<Skeleton className="h-4 w-3/4" />
			<Skeleton className="h-3 w-1/2" />
			<Skeleton className="h-3 w-1/3" />
		</div>
	)
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
	return (
		<div className="space-y-2">
			{Array.from({ length: rows }).map((_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
				<div key={i} className="flex items-center gap-3 py-2">
					<Skeleton className="h-4 w-4 rounded-full" />
					<Skeleton className="h-4 flex-1" />
					<Skeleton className="h-4 w-16" />
				</div>
			))}
		</div>
	)
}
