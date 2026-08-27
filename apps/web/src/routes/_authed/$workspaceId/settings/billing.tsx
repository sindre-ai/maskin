import { BillingSection } from '@/components/settings/billing-section'
import { BillingUsageDetails, useWorkspaceModelUsage } from '@/components/settings/billing-usage'
import { RouteError } from '@/components/shared/route-error'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/billing')({
	component: BillingPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/**
 * Settings → Billing.
 *
 * Plan, credits and cancellation come from `BillingSection`, which is the one
 * component wired to the plans/credits/hard-cap API (`/api/billing/*`). The
 * per-agent cost breakdown below it is derived from session usage
 * (`/api/sessions/usage`), a different source — it answers "where did the money
 * go", which the plan card deliberately doesn't.
 */
function BillingPage() {
	const { workspace, workspaceId } = useWorkspace()
	const usage = useWorkspaceModelUsage(workspaceId)

	return (
		<div className="flex max-w-[940px] flex-col gap-6">
			<BillingSection workspaceId={workspaceId} byollmAllowed={Boolean(workspace.byollmAllowed)} />
			<BillingUsageDetails usage={usage} />
		</div>
	)
}
