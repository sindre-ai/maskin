import { formatResetsIn } from '@/components/settings/billing-section'
import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import type { BillingPlan } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

const NEAR_CAP_HEADROOM = 0.15

const PLAN_LABEL: Record<BillingPlan, string> = {
	trial: 'trial',
	starter: 'Starter',
	pro: 'Pro',
	byollm: '',
}

/**
 * Top-of-shell banner that fires when a paid or trial workspace has burned >85%
 * of its period token cap. Hidden in the normal state and not user-dismissible
 * — it goes away on its own when usage drops below the threshold or the cap
 * resets at period_start. The over-cap variant is Task dcfe3afe.
 */
export function NearCapBanner({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)

	if (!usage) return null
	if (usage.plan === 'byollm') return null

	const cap = usage.hard_cap_tokens
	if (cap == null || cap <= 0) return null

	const used = usage.tokens_used
	if (!Number.isFinite(used) || used < 0) return null
	if (used >= cap) return null

	const headroom = (cap - used) / cap
	if (headroom >= NEAR_CAP_HEADROOM) return null

	const planLabel = PLAN_LABEL[usage.plan]
	if (!planLabel) return null

	const pctUsed = Math.min(99, Math.floor((used / cap) * 100))
	const resetsIn = formatResetsIn(usage.period_resets_in_ms)

	return (
		<output className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-foreground">
			<AlertTriangle size={14} className="text-warning shrink-0" aria-hidden />
			<span className="min-w-0">
				You've used {pctUsed}% of your {planLabel} credits
				{resetsIn ? ` · ${resetsIn}` : ''}
			</span>
			<div className="ml-auto flex flex-wrap items-center gap-2">
				<Button asChild size="sm">
					<Link to="/$workspaceId/settings/keys" params={{ workspaceId }}>
						Upgrade
					</Link>
				</Button>
				<Button asChild size="sm" variant="outline">
					<Link to="/$workspaceId/settings/keys" params={{ workspaceId }}>
						Switch to BYO key
					</Link>
				</Button>
			</div>
		</output>
	)
}
