import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import { trialCardState } from '@/lib/trial'
import { Link } from '@tanstack/react-router'

/**
 * Left-nav card for a workspace still on its trial: how long is left and a way
 * to pick a plan. Renders nothing on any other plan, while usage is loading or
 * has failed, and once the trial has ended (the expiry banner owns that).
 */
export function TrialCard({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	const state = trialCardState(usage)
	if (!state) return null

	return (
		<section
			aria-label="Trial"
			className="rounded-xl bg-warning/10 p-3 group-data-[collapsible=icon]:hidden"
		>
			<p className="text-[13px] font-bold text-warning">{state.title}</p>
			<p className="mt-0.5 text-xs text-warning">Choose a plan to keep your agents running.</p>
			<Button asChild size="sm" className="mt-2.5 w-full max-md:h-11">
				<Link to="/$workspaceId/settings/billing" params={{ workspaceId }}>
					Upgrade
				</Link>
			</Button>
		</section>
	)
}
