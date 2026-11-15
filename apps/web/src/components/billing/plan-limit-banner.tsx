import { PLAN_NAME } from '@/components/billing/plan-picker'
import { PlanExpiredDialog } from '@/components/billing/trial-expired-banner'
import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import { usePlanUsage } from '@/hooks/use-plan-usage'
import type { BillingUsageResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { periodEndLabel } from '@/lib/plan-usage'
import type { PaidPlan } from '@maskin/shared'
import { AlertTriangle } from 'lucide-react'
import { type ReactNode, useState } from 'react'

/**
 * What the 100% screens say, for the plan in front of them. A trial waits until
 * the trial ends; a paid plan waits until the month rolls over. Both can be
 * ended by picking a plan now. Words are the design spec's.
 */
export function planLimitCopy(usage: Pick<BillingUsageResponse, 'plan' | 'period_resets_in_ms'>): {
	banner: string
	button: string
	notice: string
} {
	const resets = periodEndLabel(usage.period_resets_in_ms)
	if (usage.plan === 'trial') {
		return {
			banner: `You have used 100% of your trial. New work waits until your trial ends${
				resets ? ` on ${resets}` : ''
			}, or you can choose a plan now.`,
			button: 'Choose a plan',
			notice:
				'Your agents are paused. Your plan is used up. Work starts again when you choose a plan.',
		}
	}
	const name = PLAN_NAME[usage.plan as PaidPlan] ?? 'plan'
	return {
		banner: `You have used 100% of your ${name} plan. New work waits until ${
			resets ?? 'next month'
		}, or you can change plan now.`,
		button: 'Change plan',
		notice: `Your agents are paused. Your plan is used up. Work starts again on ${
			resets ?? 'the next period'
		}, or when you change plan.`,
	}
}

/**
 * The shared read behind the banner and the composer notice: only when the plan
 * is used up and nothing lets new work start, and not when the expired banner
 * already owns the screen (period over).
 */
function usePlanLimitPause(workspaceId: string) {
	const { data: usage } = useBillingUsage(workspaceId)
	const { state } = usePlanUsage(workspaceId)
	if (!usage || !state?.paused) return null
	if (usage.period_resets_in_ms === 0) return null
	return { usage, copy: planLimitCopy(usage) }
}

/** Banner under the header at 100%, with a way to the plan picker. */
export function PlanLimitBanner({ workspaceId }: { workspaceId: string }) {
	const pause = usePlanLimitPause(workspaceId)
	const [open, setOpen] = useState(false)

	if (!pause) return null
	return (
		<>
			<output className="relative z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
				<div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-warning">
					<AlertTriangle size={14} className="shrink-0" />
					<span>{pause.copy.banner}</span>
				</div>
				<Button size="sm" variant="outline" onClick={() => setOpen(true)} className="shrink-0">
					{pause.copy.button}
				</Button>
			</output>
			<PlanExpiredDialog
				workspaceId={workspaceId}
				plan={pause.usage.plan}
				open={open}
				onOpenChange={setOpen}
				reason="limit"
			/>
		</>
	)
}

/**
 * Wraps the chat composer. At 100% it puts the "agents are paused" notice above
 * the composer and dims it. The composer stays usable on purpose: a message sent
 * while paused is refused by the server with the same words, and a plan change
 * lifts the pause without a reload.
 */
export function PlanLimitComposerGate({
	workspaceId,
	enabled,
	children,
}: {
	workspaceId: string
	enabled: boolean
	children: ReactNode
}) {
	const state = usePlanLimitPause(workspaceId)
	const pause = enabled ? state : null
	const paused = pause !== null
	return (
		<>
			{pause && (
				<p
					role="alert"
					className="mb-2 rounded-lg border border-ask-border bg-ask-surface px-3.5 py-2.5 text-sm text-foreground"
				>
					{pause.copy.notice}
				</p>
			)}
			<div className={cn(paused && 'opacity-60')}>{children}</div>
		</>
	)
}
