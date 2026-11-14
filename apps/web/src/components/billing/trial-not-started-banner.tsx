import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

/**
 * Shown to someone who signed up and left the card step before adding a card (bet "A card to
 * start a 7-day trial"). Nothing runs until the trial has started, so the banner says so and
 * reopens the card step. It renders only while the workspace is waiting for its card, a state the
 * server creates only when the trial-card-percent flag is on, so with the flag off it never shows.
 */
export function TrialNotStartedBanner({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	if (usage?.trial_state !== 'awaiting_card') return null

	return (
		<div className="relative z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
			<div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-warning">
				<AlertTriangle size={14} className="shrink-0" />
				<span>Your trial has not started. Add a card to begin your 7 days.</span>
			</div>
			<Button asChild size="sm" variant="outline" className="shrink-0">
				<Link to="/start-trial/$workspaceId" params={{ workspaceId }}>
					Add card
				</Link>
			</Button>
		</div>
	)
}
