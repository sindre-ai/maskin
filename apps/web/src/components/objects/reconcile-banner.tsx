import { Button } from '@/components/ui/button'
import type { ReconcileBannerStatus } from '@/hooks/use-content-reconcile'
import { cn } from '@/lib/cn'
import { AlertTriangle } from 'lucide-react'

interface ReconcileBannerProps {
	status: ReconcileBannerStatus
	onReview: () => void
	onKeepMine: () => void
	onTakeTheirs: () => void
}

// Sticky banner shown when autosave hits a 409. Three actions, no dismiss X —
// per the task's constraint that a lost banner is a silent clobber.
export function ReconcileBanner({
	status,
	onReview,
	onKeepMine,
	onTakeTheirs,
}: ReconcileBannerProps) {
	if (status === 'idle') return null
	const busy = status === 'retrying'
	return (
		<div
			role="alert"
			aria-live="assertive"
			className={cn(
				'sticky top-0 z-20 mb-4 flex flex-col gap-2 rounded-md border border-warning/40',
				'bg-warning/10 px-3 py-2 text-sm text-foreground',
				'sm:flex-row sm:items-center sm:justify-between',
			)}
		>
			<div className="flex items-start gap-2 sm:items-center">
				<AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning sm:mt-0" />
				<span>Content changed underneath you</span>
			</div>
			<div className="flex flex-wrap gap-2">
				<Button size="sm" variant="ghost" onClick={onReview} disabled={busy}>
					Review
				</Button>
				<Button size="sm" variant="secondary" onClick={onKeepMine} disabled={busy}>
					{busy ? 'Retrying…' : 'Keep mine'}
				</Button>
				<Button size="sm" variant="destructive" onClick={onTakeTheirs} disabled={busy}>
					Take theirs
				</Button>
			</div>
		</div>
	)
}
