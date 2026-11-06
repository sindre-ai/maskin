import { BillingSection } from '@/components/settings/billing-section'
import { BillingUsageDetails, useWorkspaceModelUsage } from '@/components/settings/billing-usage'
import { DailyBudgetSection } from '@/components/settings/daily-budget-section'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
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
 *
 * The Daily budget setting sits directly under the usage banner and is the one
 * place the `daily-budget` flag is read (see .claude/rules/feature-flags.md).
 */
function BillingPage() {
	const { workspace, workspaceId } = useWorkspace()
	const usage = useWorkspaceModelUsage(workspaceId)
	const dailyBudget = useFeatureFlag('daily-budget')
	// The API only lets human owners and admins write the target.
	const canEdit = workspace.role === 'owner' || workspace.role === 'admin'

	return (
		<div className="flex max-w-[940px] flex-col gap-6">
			<BillingSection
				workspaceId={workspaceId}
				enterprise={Boolean(workspace.enterprise)}
				afterBanner={
					dailyBudget ? (
						<DailyBudgetSection workspaceId={workspaceId} canEdit={canEdit} />
					) : undefined
				}
			/>
			<BillingUsageDetails usage={usage} />
		</div>
	)
}
