import { BillingSection } from '@/components/settings/billing-section'
import { BillingUsageDetails, useWorkspaceModelUsage } from '@/components/settings/billing-usage'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useWorkspace } from '@/lib/workspace-context'
import { Navigate, createFileRoute } from '@tanstack/react-router'

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
function BillingPageV2() {
	const { workspace, workspaceId } = useWorkspace()
	const usage = useWorkspaceModelUsage(workspaceId)

	return (
		<div className="flex max-w-[940px] flex-col gap-6">
			<BillingSection workspaceId={workspaceId} enterprise={Boolean(workspace.enterprise)} />
			<BillingUsageDetails usage={usage} />
		</div>
	)
}

// `new-design` boundary. This route has no pre-v2 counterpart — before v2,
// billing lived inside Settings → Keys and the pre-v2 nav never linked here, so
// with the flag off we send the user back to where billing used to live.
function BillingPage() {
	const { workspaceId } = useWorkspace()
	return useFeatureFlag('new-design') ? (
		<BillingPageV2 />
	) : (
		<Navigate to="/$workspaceId/settings/keys" params={{ workspaceId }} replace />
	)
}
