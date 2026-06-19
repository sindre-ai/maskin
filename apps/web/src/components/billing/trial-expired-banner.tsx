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
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'

export function TrialExpiredBanner({ workspaceId }: { workspaceId: string }) {
	const { data: usage } = useBillingUsage(workspaceId)
	const [hasExpired, setHasExpired] = useState(false)
	const [dialogOpen, setDialogOpen] = useState(false)

	// Sticky: once expired, stay expired until the plan changes away from trial
	useEffect(() => {
		if (!usage) return
		if (usage.plan !== 'trial') {
			setHasExpired(false)
			return
		}
		if (usage.period_resets_in_ms === 0) {
			setHasExpired(true)
		}
	}, [usage])

	if (!hasExpired) return null

	return (
		<>
			<div className="relative z-20 flex items-center justify-between gap-4 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
				<div className="flex items-center gap-2 text-sm text-warning">
					<AlertTriangle size={14} className="shrink-0" />
					<span>Your trial has expired. Upgrade to keep using Maskin's hosted LLM.</span>
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
			<TrialExpiredDialog
				workspaceId={workspaceId}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>
		</>
	)
}

function TrialExpiredDialog({
	workspaceId,
	open,
	onOpenChange,
}: {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const checkout = useStripeCheckout(workspaceId)
	const cancel = useBillingCancel(workspaceId)

	const handleUpgrade = (plan: 'starter' | 'pro') => {
		const base = window.location.href.split('?')[0]
		checkout.mutate(
			{
				plan,
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
					<DialogTitle>Your trial has expired</DialogTitle>
					<DialogDescription>
						Choose a plan to keep using Maskin's hosted LLM, or downgrade to Free and connect your
						own.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					<Button
						className="w-full justify-start"
						onClick={() => handleUpgrade('starter')}
						disabled={isPending}
					>
						Continue with Starter — $20/mo
					</Button>
					<Button
						className="w-full justify-start"
						variant="outline"
						onClick={() => handleUpgrade('pro')}
						disabled={isPending}
					>
						Upgrade to Pro — $60/mo
					</Button>
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
