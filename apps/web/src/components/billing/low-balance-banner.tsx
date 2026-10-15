import { formatUsd } from '@/components/settings/billing-usage'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import { trackLowBalanceBannerShown } from '@/lib/analytics'
import { decideLowBalance } from '@/lib/low-balance-threshold'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

/**
 * Persistent low-balance warning rendered inside the workspace shell, above
 * `<main>`. Fires the `credits_low_balance_banner_shown` PostHog event on
 * FIRST render per workspace-session (not per pageview), stays dismissible
 * per session in local component state, and re-appears on next page load
 * while the balance is still under threshold.
 *
 * The threshold formula lives in `lib/low-balance-threshold.ts` so it can be
 * unit-tested without a rendered tree; both the show/hide decision and the
 * `threshold_used` PostHog property come from the same call.
 *
 * The flag boundary (`MASKIN_CREDIT_UX`) lives one level up in the workspace
 * shell — see `apps/web/src/routes/_authed/$workspaceId.tsx`. This component
 * assumes the boundary already gated it in, per the "one flag boundary per
 * feature, as high in the tree as possible" rule in
 * `.claude/rules/feature-flags.md`.
 */
export function LowBalanceBanner({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	const [dismissed, setDismissed] = useState(false)
	const analyticsFiredRef = useRef(false)

	const decision = usage
		? decideLowBalance({
				creditBalanceCents: usage.credit_balance_cents,
				sumTopupsLast30dCents: usage.sum_topups_last_30d_cents,
			})
		: { show: false, thresholdCents: 0 }

	// Fire the shown event once per workspace-session — NOT per pageview. Both
	// the dismissed flag and the ref reset when this component unmounts (e.g.
	// on workspace switch), which is exactly the workspace-session boundary
	// per the bet spec. Guard on `usage` so the event doesn't race the initial
	// fetch and fire with a zero balance from stale defaults.
	useEffect(() => {
		if (!usage || !decision.show || dismissed || analyticsFiredRef.current) return
		analyticsFiredRef.current = true
		trackLowBalanceBannerShown({
			workspace_id: workspaceId,
			balance_cents: usage.credit_balance_cents,
			threshold_used: decision.thresholdCents,
		})
	}, [usage, decision.show, decision.thresholdCents, dismissed, workspaceId])

	if (!usage || !decision.show || dismissed) return null

	return (
		<Banner
			data-testid="low-balance-banner"
			message={
				<>
					Low credit balance ({formatUsd(usage.credit_balance_cents / 100)}). Top up to keep your
					agents running.
				</>
			}
			action={
				<Button asChild size="sm" variant="outline" className="shrink-0">
					<Link to="/$workspaceId/settings/billing" params={{ workspaceId }}>
						Top up credits
					</Link>
				</Button>
			}
			onDismiss={() => setDismissed(true)}
			dismissLabel="Dismiss low balance warning"
		/>
	)
}
