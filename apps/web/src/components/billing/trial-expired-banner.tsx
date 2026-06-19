import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { useBillingCancel, useBillingUsage, useStripeCheckout } from '@/hooks/use-billing'
import type { BillingPlan } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'

const EXPIRED_PLANS = new Set<BillingPlan>(['trial', 'starter', 'pro'])

function bannerText(plan: BillingPlan): string {
	if (plan === 'trial') return "Your trial has expired. Upgrade to keep using Maskin's hosted LLM."
	return `Your ${plan === 'pro' ? 'Pro' : 'Starter'} plan period has ended. Renew to continue.`
}

function dialogTitle(plan: BillingPlan): string {
	if (plan === 'trial') return 'Your trial has expired'
	return `Your ${plan === 'pro' ? 'Pro' : 'Starter'} plan period has ended`
}

export function TrialExpiredBanner({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	const [expiredPlan, setExpiredPlan] = useState<BillingPlan | null>(null)
	const [dialogOpen, setDialogOpen] = useState(false)

	// Sticky per-plan: once a plan's period hits 0, keep showing until plan changes
	useEffect(() => {
		if (!usage) return
		if (!EXPIRED_PLANS.has(usage.plan)) {
			setExpiredPlan(null)
			return
		}
		if (usage.period_resets_in_ms === 0) {
			setExpiredPlan(usage.plan)
		}
	}, [usage])

	if (!expiredPlan) return null

	return (
		<>
			<div className="relative z-20 flex items-center justify-between gap-4 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
				<div className="flex items-center gap-2 text-sm text-warning">
					<AlertTriangle size={14} className="shrink-0" />
					<span>{bannerText(expiredPlan)}</span>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={() => setDialogOpen(true)}
					className="shrink-0"
				>
					Check billing
				</Button>
			</div>
			<PlanExpiredDialog
				workspaceId={workspaceId}
				plan={expiredPlan}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>
		</>
	)
}

function PlanExpiredDialog({
	workspaceId,
	plan,
	open,
	onOpenChange,
}: {
	workspaceId: string
	plan: BillingPlan
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const checkout = useStripeCheckout(workspaceId)
	const cancel = useBillingCancel(workspaceId)

	const handleUpgrade = (target: 'starter' | 'pro') => {
		const base = window.location.href.split('?')[0]
		checkout.mutate(
			{
				plan: target,
				success_url: `${base}?billing=success`,
				cancel_url: `${base}?billing=cancel`,
			},
			{
				onSuccess: ({ url }) => {
					window.location.href = url
				},
			},
		)
	}

	const handleDowngrade = () => {
		cancel.mutate(undefined, { onSuccess: () => onOpenChange(false) })
	}

	const isPending = checkout.isPending || cancel.isPending

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{dialogTitle(plan)}</DialogTitle>
					<DialogDescription>
						Choose a plan to keep using Maskin's hosted LLM, or downgrade to Free and connect your
						own.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					{plan === 'pro' ? (
						<>
							<Button
								className="w-full justify-start"
								onClick={() => handleUpgrade('pro')}
								disabled={isPending}
							>
								Renew Pro — $60/mo
							</Button>
							<Button
								className="w-full justify-start"
								variant="outline"
								onClick={() => handleUpgrade('starter')}
								disabled={isPending}
							>
								Downgrade to Starter — $20/mo
							</Button>
						</>
					) : (
						<>
							<Button
								className="w-full justify-start"
								onClick={() => handleUpgrade('starter')}
								disabled={isPending}
							>
								Renew Starter — $20/mo
							</Button>
							<Button
								className="w-full justify-start"
								variant="outline"
								onClick={() => handleUpgrade('pro')}
								disabled={isPending}
							>
								Upgrade to Pro — $60/mo
							</Button>
						</>
					)}
					<Button
						className="w-full justify-start"
						variant="ghost"
						onClick={handleDowngrade}
						disabled={isPending}
					>
						{cancel.isPending ? 'Downgrading…' : 'Downgrade to Free'}
					</Button>
				</div>

				{(checkout.isError || cancel.isError) && (
					<p className="text-xs text-error">
						{checkout.error?.message ?? cancel.error?.message ?? 'Something went wrong.'}
					</p>
				)}

				<DialogFooter className="sm:justify-start">
					<Link
						to="/$workspaceId/settings/keys"
						params={{ workspaceId }}
						onClick={() => onOpenChange(false)}
						className="text-xs text-muted-foreground hover:text-foreground"
					>
						Go to billing settings →
					</Link>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
