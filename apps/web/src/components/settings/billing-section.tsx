import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useBillingCancel, useBillingUsage, useStripeCheckout } from '@/hooks/use-billing'
import type { BillingPlan, BillingStatus, BillingUsageResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Check, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

const PLAN_LABEL: Record<BillingPlan, string> = {
	trial: 'Trial',
	pro: 'Pro — $20/mo',
	team: 'Team — $200/mo',
	byollm: 'Enterprise',
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
	return ''
}

const DAY_MS = 24 * 60 * 60 * 1000

// 8_000_000 / 32_000_000 / 320_000_000 below mirror TRIAL_HARD_CAP_DEFAULT_TOKENS /
// PRO_HARD_CAP_DEFAULT_TOKENS / TEAM_HARD_CAP_DEFAULT_TOKENS in
// apps/dev/src/lib/billing-defaults.ts and the .env.example
// MASKIN_*_HARD_CAP_TOKENS defaults. Keep in sync when bumping — enforced by
// scripts/verify-billing-cap-literals.mjs.
const CAP_DEFAULTS = { trial: 8_000_000, pro: 32_000_000, team: 320_000_000 } as const

interface PlanCardConfig {
	plan: BillingPlan
	eyebrow: string
	price: string
	priceSuffix: string
	tagline: string
	features: string[]
}

const PLAN_CONFIG: PlanCardConfig[] = [
	{
		plan: 'trial',
		eyebrow: 'TRIAL',
		price: 'Free',
		priceSuffix: '/14 days',
		tagline: 'Full product, no card. $5 of usage on the house.',
		features: [
			`${formatTokens(CAP_DEFAULTS.trial)} tokens included`,
			'Hosted by Maskin — no API key needed',
		],
	},
	{
		plan: 'pro',
		eyebrow: 'PRO',
		price: '$20',
		priceSuffix: '/mo',
		tagline: 'For teams running real workflows day to day.',
		features: [
			`${formatTokens(CAP_DEFAULTS.pro)} tokens of usage included each month`,
			'More usage at cost, no markup',
			'Hosted by Maskin — no API key needed',
		],
	},
	{
		plan: 'team',
		eyebrow: 'TEAM',
		price: '$200',
		priceSuffix: '/mo',
		tagline: 'Heavier loops, volume rates, one invoice.',
		features: [
			`${formatTokens(CAP_DEFAULTS.team)} tokens of usage included each month`,
			'Volume rate beyond that',
			'Hosted by Maskin — no API key needed',
		],
	},
	{
		plan: 'byollm',
		eyebrow: 'ENTERPRISE',
		price: 'BYOL',
		priceSuffix: '',
		tagline: 'Bring your own LLM. Pay by invoice. Full control.',
		features: [
			'No Maskin-hosted token cap',
			'Use your own Claude Pro/Max, Anthropic API key, or custom endpoint',
		],
	},
]

function PeriodCountdown({ ms, label }: { ms: number; label: string }) {
	const [remaining, setRemaining] = useState(ms)

	useEffect(() => {
		setRemaining(ms)
		if (ms <= 0) return
		const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1000)), 1000)
		return () => clearInterval(id)
	}, [ms])

	if (remaining <= 0) return <span>· {label} now</span>

	const h = Math.floor(remaining / 3_600_000)
	const m = Math.floor((remaining % 3_600_000) / 60_000)
	const s = Math.floor((remaining % 60_000) / 1_000)
	const hms =
		h > 0
			? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
			: `${m}:${String(s).padStart(2, '0')}`

	return (
		<span>
			· {label} in {hms}
		</span>
	)
}

function statusBadge(plan: BillingPlan, status: BillingStatus): { label: string; tone: string } {
	if (plan === 'byollm') return { label: 'BYOL', tone: 'bg-muted text-muted-foreground' }
	if (status === 'active') return { label: 'Active', tone: 'bg-success/10 text-success' }
	if (status === 'past_due') return { label: 'Past due', tone: 'bg-warning/10 text-warning' }
	if (status === 'canceled') return { label: 'Canceled', tone: 'bg-muted text-muted-foreground' }
	return { label: status, tone: 'bg-muted text-muted-foreground' }
}

interface PlanCta {
	label: string
	onClick: () => void
	disabled: boolean
	variant?: 'outline' | 'ghost'
}

function getPlanCta(
	planKey: BillingPlan,
	usage: BillingUsageResponse,
	isTrial: boolean,
	isPaid: boolean,
	byollmAllowed: boolean,
	checkoutPending: boolean,
	handleUpgrade: (plan: 'pro' | 'team') => void,
	openSwitch: () => void,
): PlanCta | null {
	if (planKey === usage.plan) return null

	if (planKey === 'trial') {
		if (isPaid && usage.status === 'active' && !byollmAllowed) {
			return {
				label: 'Cancel subscription',
				onClick: openSwitch,
				disabled: false,
				variant: 'ghost',
			}
		}
		return null
	}

	if (planKey === 'pro') {
		if (isTrial || usage.status !== 'active') {
			return {
				label: 'Upgrade to Pro',
				onClick: () => handleUpgrade('pro'),
				disabled: checkoutPending,
			}
		}
		return null
	}

	if (planKey === 'team') {
		if (
			isTrial ||
			usage.status !== 'active' ||
			(usage.plan === 'pro' && usage.status === 'active')
		) {
			return {
				label: 'Upgrade to Team',
				onClick: () => handleUpgrade('team'),
				disabled: checkoutPending,
				variant: 'outline',
			}
		}
		return null
	}

	// byollm
	if (isPaid && usage.status === 'active') {
		return { label: 'Downgrade to Free', onClick: openSwitch, disabled: false, variant: 'ghost' }
	}
	return null
}

export function BillingSection({
	workspaceId,
	byollmAllowed = false,
}: {
	workspaceId: string
	byollmAllowed?: boolean
}) {
	const usageQuery = useBillingUsage(workspaceId)
	const checkout = useStripeCheckout(workspaceId)
	const [switchOpen, setSwitchOpen] = useState(false)
	// null = no explicit user choice yet — fall back to a computed default once
	// `usage` is known (collapsed for paid+active plans, expanded otherwise).
	// Declared here (not after the early returns below) so the hook is always
	// called on every render regardless of loading/error state.
	const [plansOpenOverride, setPlansOpenOverride] = useState<boolean | null>(null)

	const handleUpgrade = (plan: 'pro' | 'team') => {
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
	const isPaid = usage.plan === 'pro' || usage.plan === 'team'
	const isTrial = usage.plan === 'trial'
	const cap = usage.hard_cap_tokens ?? 0
	const pct = cap > 0 ? Math.min(100, Math.round((usage.tokens_used / cap) * 100)) : 0
	const periodMs = usage.period_resets_in_ms
	const resetsIn = formatResetsIn(periodMs)

	const visiblePlans = PLAN_CONFIG.filter((config) => config.plan !== 'byollm' || byollmAllowed)
	const defaultPlansOpen = !(isPaid && usage.status === 'active')
	const plansOpen = plansOpenOverride ?? defaultPlansOpen

	return (
		<div>
			<Label className="mb-1 text-bold">Maskin Subscription</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Hosted LLM — pay Maskin, no API key needed. Hard-capped tokens per period so spend never
				surprises you.
			</p>

			<UsageBanner
				usage={usage}
				badge={badge}
				isByo={isByo}
				isTrial={isTrial}
				isPaid={isPaid}
				cap={cap}
				pct={pct}
				periodMs={periodMs}
				resetsIn={resetsIn}
			/>

			{checkout.isError && (
				<p className="mt-2 text-xs text-error">
					{checkout.error?.message ?? 'Could not start checkout.'}
				</p>
			)}

			<Collapsible open={plansOpen} onOpenChange={setPlansOpenOverride} className="mt-4">
				<CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
					{plansOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					{plansOpen ? 'Hide plans' : 'Compare plans'}
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
						{visiblePlans.map((config) => (
							<PlanCard
								key={config.plan}
								config={config}
								isCurrent={config.plan === usage.plan}
								cta={getPlanCta(
									config.plan,
									usage,
									isTrial,
									isPaid,
									byollmAllowed,
									checkout.isPending,
									handleUpgrade,
									() => setSwitchOpen(true),
								)}
							/>
						))}
					</div>
				</CollapsibleContent>
			</Collapsible>

			<DowngradeDialog
				open={switchOpen}
				onOpenChange={setSwitchOpen}
				workspaceId={workspaceId}
				byollmAllowed={byollmAllowed}
			/>
		</div>
	)
}

function UsageBanner({
	usage,
	badge,
	isByo,
	isTrial,
	isPaid,
	cap,
	pct,
	periodMs,
	resetsIn,
}: {
	usage: BillingUsageResponse
	badge: { label: string; tone: string }
	isByo: boolean
	isTrial: boolean
	isPaid: boolean
	cap: number
	pct: number
	periodMs: number | null
	resetsIn: string
}) {
	const needsAttention = usage.status === 'past_due' || usage.status === 'canceled' || pct >= 85

	return (
		<div
			data-testid="usage-banner"
			className={cn(
				'rounded-lg border p-3 space-y-3',
				needsAttention ? 'border-warning/30 bg-warning/10' : 'border-border bg-bg-surface',
			)}
		>
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
						{periodMs !== null && periodMs > 0 && periodMs < DAY_MS ? (
							<PeriodCountdown ms={periodMs} label={isTrial ? 'expires' : 'resets'} />
						) : resetsIn ? (
							<span>· {resetsIn}</span>
						) : null}
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
		</div>
	)
}

function PlanCard({
	config,
	isCurrent,
	cta,
}: {
	config: PlanCardConfig
	isCurrent: boolean
	cta: PlanCta | null
}) {
	return (
		<div className="flex flex-col rounded-lg border border-border bg-bg-surface p-3 gap-3">
			<div>
				<div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{config.eyebrow}
				</div>
				<div className="mt-1 flex items-baseline gap-1">
					<span className="text-lg font-semibold text-foreground">{config.price}</span>
					{config.priceSuffix && (
						<span className="text-xs text-muted-foreground">{config.priceSuffix}</span>
					)}
				</div>
				<p className="mt-1 text-xs text-muted-foreground">{config.tagline}</p>
			</div>

			<ul className="flex-1 space-y-1.5">
				{config.features.map((feature) => (
					<li key={feature} className="flex items-start gap-1.5 text-xs text-muted-foreground">
						<Check size={14} className="mt-0.5 shrink-0 text-success" />
						<span>{feature}</span>
					</li>
				))}
			</ul>

			{isCurrent ? (
				<Button size="sm" variant="outline" disabled>
					Current plan
				</Button>
			) : cta ? (
				<Button size="sm" variant={cta.variant} onClick={cta.onClick} disabled={cta.disabled}>
					{cta.label}
				</Button>
			) : null}
		</div>
	)
}

function DowngradeDialog({
	open,
	onOpenChange,
	workspaceId,
	byollmAllowed,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	byollmAllowed: boolean
}) {
	const cancel = useBillingCancel(workspaceId)

	const handleConfirm = () => {
		cancel.mutate(undefined, { onSuccess: () => onOpenChange(false) })
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{byollmAllowed ? 'Downgrade to Free?' : 'Cancel subscription?'}</DialogTitle>
					<DialogDescription>
						{byollmAllowed
							? "You'll lose access to Maskin's hosted LLM and your remaining token credits for this period. You won't be charged again."
							: "You'll go back to the free trial plan with Maskin's hosted LLM, on the trial's lower usage cap. You won't be charged again."}
					</DialogDescription>
				</DialogHeader>
				{cancel.isError && (
					<p className="text-xs text-error">{cancel.error?.message ?? 'Something went wrong.'}</p>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleConfirm} disabled={cancel.isPending}>
						{cancel.isPending ? 'Downgrading…' : 'Confirm downgrade'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
