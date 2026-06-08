import { useBillingUsage } from '@/hooks/use-billing'
import { PLAN_LABEL_SHORT, deriveBillingState, formatResetsIn } from '@/lib/billing-format'
import { Link } from '@tanstack/react-router'
import { OctagonAlert } from 'lucide-react'

/**
 * Reads billing state and returns whether the current workspace's paid-plan
 * agent launch path should be blocked. Single source of truth for any surface
 * that creates a session against the workspace's plan tokens.
 *
 * Returns false for BYO workspaces (no cap to enforce) and while billing usage
 * is loading — we err on the side of letting the call go through rather than
 * pre-emptively blocking the user; enforcement on the backend will reject the
 * call with 402 if the workspace actually is over-cap, and the global
 * mutationCache handler will refetch billing so the banner appears.
 */
export function useOverCapBlock(workspaceId: string): boolean {
	const { data: usage } = useBillingUsage(workspaceId)
	return deriveBillingState(usage) === 'over-cap'
}

/**
 * Inline notice rendered above any composer (chat input, agent instruction
 * log, retry button) when the workspace has exhausted its plan cap. Matches
 * the over-cap banner copy so the user gets a consistent story regardless of
 * which surface they're on:
 *
 * - banner (top of shell):        "You're over your Starter cap · resets in 5d"
 * - composer notice (this):       "Agents paused — out of credits, resets in 5d"
 *
 * Returns null on every other state so callers can mount it unconditionally.
 */
export function OverCapComposerNotice({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	if (deriveBillingState(usage) !== 'over-cap' || !usage) return null

	const planLabel = PLAN_LABEL_SHORT[usage.plan]
	if (!planLabel) return null

	const resetsIn = formatResetsIn(usage.period_resets_in_ms)

	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-foreground"
		>
			<OctagonAlert size={12} className="text-error shrink-0" aria-hidden />
			<span className="min-w-0">
				Agents paused — out of credits{resetsIn ? `, ${resetsIn}` : ''}.{' '}
				<Link
					to="/$workspaceId/settings/keys"
					params={{ workspaceId }}
					className="underline hover:text-foreground"
				>
					Upgrade
				</Link>{' '}
				or{' '}
				<Link
					to="/$workspaceId/settings/keys"
					params={{ workspaceId }}
					className="underline hover:text-foreground"
				>
					switch to BYO key
				</Link>
				.
			</span>
		</div>
	)
}
