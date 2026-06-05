import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import type { BillingPlan } from '@/lib/api'
import { PLAN_LABEL_SHORT, deriveBillingState, formatResetsIn } from '@/lib/billing-format'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, OctagonAlert } from 'lucide-react'
import type { ReactElement } from 'react'

const PRO_OVERAGE_CONTACT_MAILTO = 'mailto:support@maskin.ai?subject=Pro%20overage'

/**
 * Top-of-shell banner for paid + trial workspaces. Renders one of two states
 * derived from `useBillingUsage`:
 *
 * - near-cap (<15% headroom): warning tone, "you've used X%", upgrade + BYO
 *   escape hatch. Same shape as the original NearCapBanner from Task be5d94b7.
 * - over-cap (used >= cap): error tone, "you're over your <plan> cap",
 *   prominent upgrade CTA. Starter routes to Pro upgrade in the settings row;
 *   Pro routes to a "Contact us" mailto (Pro overage billing is out of v1).
 *
 * Hidden in the normal state and not user-dismissible — it goes away on its
 * own when the period resets or the user upgrades. The over-cap state is the
 * persistent signal that pairs with the agent-launch composer block: the
 * banner says "you're stuck, here's the upgrade", the composer says "agents
 * are paused until you do".
 */
export function UsageStateBanner({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	const state = deriveBillingState(usage)

	if (state !== 'near-cap' && state !== 'over-cap') return null
	// deriveBillingState returns near/over only when usage is fully populated,
	// but TypeScript can't narrow across the function call.
	if (!usage) return null

	const planLabel = PLAN_LABEL_SHORT[usage.plan]
	if (!planLabel) return null

	const resetsIn = formatResetsIn(usage.period_resets_in_ms)
	const settingsLink = (
		<Link to="/$workspaceId/settings/keys" params={{ workspaceId }}>
			Upgrade
		</Link>
	)
	const byoLink = (
		<Link to="/$workspaceId/settings/keys" params={{ workspaceId }}>
			Switch to BYO key
		</Link>
	)

	if (state === 'over-cap') {
		return (
			<output className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-error/40 bg-error/10 px-4 py-2 text-sm text-foreground">
				<OctagonAlert size={14} className="text-error shrink-0" aria-hidden />
				<span className="min-w-0">
					You're over your {planLabel} cap
					{resetsIn ? ` · ${resetsIn}` : ''}
				</span>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<UpgradeCta plan={usage.plan} settingsLink={settingsLink} />
					<Button asChild size="sm" variant="outline">
						{byoLink}
					</Button>
				</div>
			</output>
		)
	}

	// near-cap
	const cap = usage.hard_cap_tokens ?? 0
	const pctUsed = Math.min(99, Math.floor((usage.tokens_used / cap) * 100))
	return (
		<output className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-foreground">
			<AlertTriangle size={14} className="text-warning shrink-0" aria-hidden />
			<span className="min-w-0">
				You've used {pctUsed}% of your {planLabel} credits
				{resetsIn ? ` · ${resetsIn}` : ''}
			</span>
			<div className="ml-auto flex flex-wrap items-center gap-2">
				<Button asChild size="sm">
					{settingsLink}
				</Button>
				<Button asChild size="sm" variant="outline">
					{byoLink}
				</Button>
			</div>
		</output>
	)
}

function UpgradeCta({
	plan,
	settingsLink,
}: {
	plan: BillingPlan
	settingsLink: ReactElement
}) {
	// Pro overage billing is out of v1 (per the bet's chosen direction). Route
	// the urgent CTA to contact-sales instead of the settings row, which has no
	// Pro→? upgrade path yet.
	if (plan === 'pro') {
		return (
			<Button asChild size="sm">
				<a href={PRO_OVERAGE_CONTACT_MAILTO}>Contact us</a>
			</Button>
		)
	}
	return (
		<Button asChild size="sm">
			{settingsLink}
		</Button>
	)
}
