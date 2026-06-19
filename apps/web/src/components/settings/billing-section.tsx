import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useBillingUsage, useStripeCheckout } from '@/hooks/use-billing'
import type { BillingPlan, BillingStatus } from '@/lib/api'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

const PLAN_LABEL: Record<BillingPlan, string> = {
	trial: 'Trial',
	starter: 'Starter — $20/mo',
	pro: 'Pro — $60/mo',
	byollm: 'Free',
}

const STRIPE_BILLING_PORTAL = 'https://billing.stripe.com/p/login/maskin'

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
	return `${n}`
}

export function formatResetsIn(ms: number | null): string {
	if (ms == null || ms <= 0) return ''
	const days = Math.floor(ms / (24 * 60 * 60 * 1000))
	if (days > 0) return `resets in ${days}d`
	const hours = Math.floor(ms / (60 * 60 * 1000))
	if (hours > 0) return `resets in ${hours}h`
	return 'resets soon'
}

function statusBadge(plan: BillingPlan, status: BillingStatus): { label: string; tone: string } {
	if (plan === 'byollm') return { label: 'Free', tone: 'bg-muted text-muted-foreground' }
	if (status === 'active') return { label: 'Active', tone: 'bg-success/10 text-success' }
	if (status === 'past_due') return { label: 'Past due', tone: 'bg-warning/10 text-warning' }
	if (status === 'canceled') return { label: 'Canceled', tone: 'bg-muted text-muted-foreground' }
	return { label: status, tone: 'bg-muted text-muted-foreground' }
}

export function BillingSection({ workspaceId }: { workspaceId: string }) {
	const usageQuery = useBillingUsage(workspaceId)
	const checkout = useStripeCheckout(workspaceId)
	const [switchOpen, setSwitchOpen] = useState(false)

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

	if (usageQuery.isLoading) {
		return (
			<div>
				<Label className="mb-1 text-bold">Maskin Subscription</Label>
				<p className="text-xs text-muted-foreground">Loading…</p>
			</div>
		)
	}

	if (usageQuery.isError || !usageQuery.data) {
		return (
			<div>
				<Label className="mb-1 text-bold">Maskin Subscription</Label>
				<p className="text-xs text-error">
					{usageQuery.error?.message ?? 'Could not load subscription state.'}
				</p>
			</div>
		)
	}

	const usage = usageQuery.data
	const badge = statusBadge(usage.plan, usage.status)
	const isByo = usage.plan === 'byollm'
	const isPaid = usage.plan === 'starter' || usage.plan === 'pro'
	const isTrial = usage.plan === 'trial'
	const cap = usage.hard_cap_tokens ?? 0
	const pct = cap > 0 ? Math.min(100, Math.round((usage.tokens_used / cap) * 100)) : 0
	const resetsIn = formatResetsIn(usage.period_resets_in_ms)

	return (
		<div>
			<Label className="mb-1 text-bold">Maskin Subscription</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Hosted LLM — pay Maskin, no API key needed. Hard-capped tokens per period so spend never
				surprises you.
			</p>

			<div className="rounded-lg border border-border bg-bg-surface p-3 space-y-3">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<span className="text-sm font-medium text-foreground truncate">
							{PLAN_LABEL[usage.plan]}
						</span>
						<span className={`rounded-full px-2 py-0.5 text-xs ${badge.tone}`}>{badge.label}</span>
					</div>
					{isPaid && usage.stripe_customer_id && (
						<a
							href={STRIPE_BILLING_PORTAL}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						>
							Manage in Stripe <ExternalLink size={12} />
						</a>
					)}
				</div>

				{!isByo && cap > 0 && (
					<div>
						<div className="flex items-baseline justify-between text-xs text-muted-foreground">
							<span>
								{formatTokens(usage.tokens_used)} / {formatTokens(cap)} tokens
							</span>
							{resetsIn && <span>· {resetsIn}</span>}
						</div>
						<div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
							<div
								className={`h-full transition-all ${pct >= 100 ? 'bg-error' : pct >= 85 ? 'bg-warning' : 'bg-primary'}`}
								style={{ width: `${pct}%` }}
								role="progressbar"
								aria-valuenow={pct}
								aria-valuemin={0}
								aria-valuemax={100}
								tabIndex={-1}
							/>
						</div>
					</div>
				)}

				{isByo && (
					<p className="text-xs text-muted-foreground">
						Using your own Claude subscription, Anthropic API key, or custom endpoint. Manage in the
						rows below.
					</p>
				)}

				<div className="flex flex-wrap items-center gap-2">
					{(isTrial || usage.status !== 'active') && (
						<>
							<Button
								size="sm"
								onClick={() => handleUpgrade('starter')}
								disabled={checkout.isPending}
							>
								Upgrade to Starter
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => handleUpgrade('pro')}
								disabled={checkout.isPending}
							>
								Upgrade to Pro
							</Button>
						</>
					)}
					{usage.plan === 'starter' && usage.status === 'active' && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => handleUpgrade('pro')}
							disabled={checkout.isPending}
						>
							Upgrade to Pro
						</Button>
					)}
					{isPaid && usage.status === 'active' && (
						<Button size="sm" variant="ghost" onClick={() => setSwitchOpen(true)}>
							Downgrade to Free
						</Button>
					)}
				</div>

				{checkout.isError && (
					<p className="text-xs text-error">
						{checkout.error?.message ?? 'Could not start checkout.'}
					</p>
				)}
			</div>

			<SwitchToByoDialog open={switchOpen} onOpenChange={setSwitchOpen} />
		</div>
	)
}

function SwitchToByoDialog({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Downgrade to Free?</DialogTitle>
					<DialogDescription>
						To cancel your paid plan, connect your own LLM below — Claude subscription, Anthropic
						API key, or a custom model endpoint. Saving any of them cancels your active Maskin
						subscription atomically (you won't be charged again).
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Got it
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
