import { DineroBookingCard } from '@/components/settings/dinero-booking-card'
import { DineroReviewSection, useCanReview } from '@/components/settings/dinero-review-section'

/**
 * What the flow did in Dinero, shown inside the connected Dinero card on Settings → Integrations:
 * the booking switch, the log, the reversal of a booked item and Approve the books. Admins and
 * owners only; for anyone else the card shows nothing extra and no review request is made.
 */
export function DineroIntegrationPanel({ workspaceId }: { workspaceId: string }) {
	const canReview = useCanReview()
	if (!canReview) return null
	return (
		<div className="mt-3 flex flex-col gap-6 border-t border-border-subtle pt-4">
			<DineroBookingCard workspaceId={workspaceId} />
			<DineroReviewSection workspaceId={workspaceId} />
		</div>
	)
}
