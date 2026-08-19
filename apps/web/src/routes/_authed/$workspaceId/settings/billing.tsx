import {
	BillingStat,
	BillingUsageDetails,
	BillingUsageSummary,
	type WorkspaceModelUsage,
	useWorkspaceModelUsage,
} from '@/components/settings/billing-usage'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { StatusBadge } from '@/components/shared/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { Spinner } from '@/components/ui/spinner'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import {
	useBillingSummary,
	useCompleteCheckout,
	useOpenPortal,
	useStartCheckout,
} from '@/hooks/use-billing'
import type { BillingInvoiceResponse, BillingPlanResponse } from '@/lib/api'
import { BILLING_PLAN_TIERS, type BillingPlanTier } from '@/lib/billing-plans'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { createFileRoute } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/billing')({
	component: BillingPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function formatAmount(cents: number | null, currency: string): string {
	if (cents === null) return '—'
	const amount = cents / 100
	try {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: currency.toUpperCase(),
		}).format(amount)
	} catch {
		return `${currency.toUpperCase()} ${amount.toFixed(2)}`
	}
}

// An invoice is a financial record — "2 weeks ago" is the wrong register for
// one, so invoice rows carry an absolute date (mockup 2925).
const INVOICE_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
})

/**
 * The warn variant of the plan banner (mockup 2797). Only states the billing
 * row can actually hold get a warning — there is no trial or usage-limit field
 * to warn about, so those variants are not rendered.
 */
function planWarning(status: string): string | null {
	if (status === 'declined')
		return 'The last payment was declined. Update the card on Stripe to activate this plan.'
	if (status === 'past_due')
		return 'This subscription is past due. Settle it on Stripe to keep the workspace running.'
	return null
}

/**
 * The PLAN column's sub-line (mockup 2856). Renewal is stated here as an
 * absolute date rather than repeated as a "Next charge" row — the disclosure
 * below already carries that row.
 */
function planSubLine(plan: BillingPlanResponse): string {
	if (plan.priceCents === null) return 'No active subscription'
	const price = `${formatAmount(plan.priceCents, plan.currency)} / month`
	if (!plan.nextChargeAt) return price
	return `${price} · renews ${INVOICE_DATE_FORMAT.format(new Date(plan.nextChargeAt))}`
}

function BillingPage() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useBillingSummary(workspaceId)
	const usage = useWorkspaceModelUsage(workspaceId)
	const [checkoutOpen, setCheckoutOpen] = useState(false)

	if (isLoading || !data) {
		return (
			<div className="max-w-[940px] space-y-4">
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		)
	}

	return (
		<div className="flex max-w-[940px] flex-col gap-6">
			<PlanSummary
				workspaceId={workspaceId}
				plan={data.plan}
				configured={data.configured}
				testMode={data.testMode}
				usage={usage}
				onChangePlan={() => setCheckoutOpen(true)}
			/>
			<PlansSection
				plan={data.plan}
				configured={data.configured}
				onChoosePlan={() => setCheckoutOpen(true)}
			/>
			<BillingUsageDetails usage={usage} />
			<AccountDisclosure
				workspaceId={workspaceId}
				plan={data.plan}
				configured={data.configured}
				invoiceEmail={data.invoiceEmail}
				invoices={data.invoices}
			/>

			{data.configured && data.publishableKey && (
				<CheckoutDialog
					open={checkoutOpen}
					onOpenChange={setCheckoutOpen}
					workspaceId={workspaceId}
					publishableKey={data.publishableKey}
					plan={data.plan}
					currentEmail={data.invoiceEmail}
					testMode={data.testMode}
				/>
			)}
		</div>
	)
}

/**
 * The plan strip (mockup 2851–2877): three stats in a row, the change-plan
 * action, and the warn note when the subscription is unhealthy.
 *
 * The mockup's meter under the stats is not drawn. It fills used-against-
 * included, and no endpoint reports an included allowance — a meter with an
 * invented ceiling would be a claim about money the server never made.
 */
function PlanSummary({
	workspaceId,
	plan,
	configured,
	testMode,
	usage,
	onChangePlan,
}: {
	workspaceId: string
	plan: BillingPlanResponse
	configured: boolean
	testMode: boolean
	usage: WorkspaceModelUsage
	onChangePlan: () => void
}) {
	const portal = useOpenPortal(workspaceId)
	const warning = planWarning(plan.status)
	const isActive = plan.status === 'active'

	return (
		<div
			className={cn(
				'flex flex-col gap-3.5 rounded-2xl border bg-card p-4',
				warning ? 'border-warning' : 'border-border',
			)}
		>
			<div className="flex flex-wrap items-start gap-x-6 gap-y-4">
				<BillingStat
					label="PLAN"
					value={
						<span className="flex flex-wrap items-center gap-2">
							<h2 className="text-lg font-bold tracking-tight text-foreground">
								{plan.planLabel ?? plan.planId}
							</h2>
							<StatusBadge status={plan.status} />
							{testMode && <Badge variant="outline">Test mode</Badge>}
						</span>
					}
					sub={planSubLine(plan)}
				/>
				<BillingUsageSummary usage={usage} />
				<div className="flex shrink-0 flex-wrap gap-2">
					<Button
						variant="outline"
						disabled={!configured || portal.isPending}
						onClick={() => portal.mutate()}
					>
						{portal.isPending && <Spinner className="size-4" />}
						Manage on Stripe
					</Button>
					<Button variant="outline" onClick={onChangePlan} disabled={!configured}>
						{isActive ? 'Change plan' : 'Choose a plan'}
					</Button>
				</div>
			</div>

			{/* The mockup's amber note (2874) — shown only for states the billing
			    row actually holds, so there is no trial-exhaustion variant. */}
			{warning && (
				<p
					aria-live="polite"
					className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs font-medium leading-relaxed text-warning"
				>
					{warning}
				</p>
			)}

			<p className="text-xs leading-relaxed text-muted-foreground">
				Subscription and invoicing run on Stripe. Everything Stripe knows about this workspace —
				card, address, tax ID, cancellation — is managed there.
			</p>

			{!configured && (
				<p
					aria-live="polite"
					className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
				>
					Stripe is not configured for this instance. Billing is disabled until the server is set up
					with Stripe keys.
				</p>
			)}
		</div>
	)
}

/**
 * The published tiers (mockup 2880–2900), behind a Show/Hide toggle.
 *
 * An instance sells exactly one price — whatever `STRIPE_PRICE_ID` resolves to,
 * which is what `GET /api/billing` returns and what checkout charges. So only
 * the card matching that plan id can start a checkout, and it shows the API's
 * real price rather than the catalogue's advertised one: a card reading
 * "$200/month" that opened a $20 payment sheet would be a lie about money.
 * Every other tier states its published price and sends you to a conversation.
 */
function PlansSection({
	plan,
	configured,
	onChoosePlan,
}: {
	plan: BillingPlanResponse
	configured: boolean
	onChoosePlan: () => void
}) {
	const [shown, setShown] = useState(true)

	return (
		<div>
			<div className="mb-3 flex items-center gap-3">
				<h2 className="settings-label min-w-0 flex-1">PLANS</h2>
				<button
					type="button"
					onClick={() => setShown((v) => !v)}
					className="shrink-0 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
				>
					{shown ? 'Hide plans' : 'Show plans'}
				</button>
			</div>
			{shown && (
				<div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4">
					{BILLING_PLAN_TIERS.map((tier) => (
						<PlanCard
							key={tier.id}
							tier={tier}
							plan={plan}
							configured={configured}
							onChoosePlan={onChoosePlan}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function PlanCard({
	tier,
	plan,
	configured,
	onChoosePlan,
}: {
	tier: BillingPlanTier
	plan: BillingPlanResponse
	configured: boolean
	onChoosePlan: () => void
}) {
	// The workspace is *on* this tier, and paying for it.
	const isCurrent = plan.status === 'active' && plan.planId === tier.id
	// This tier is the one checkout would charge for.
	const isSold = configured && plan.planId === tier.id && !tier.contactOnly
	const isFeatured = tier.featured && !isCurrent

	// A sold tier quotes the server's price, never the catalogue's.
	const amount =
		isSold && plan.priceCents !== null ? formatAmount(plan.priceCents, plan.currency) : tier.amount
	const per = isSold && plan.priceCents !== null ? '/month' : tier.per

	return (
		<div
			className={cn(
				'relative flex flex-col gap-2.5 rounded-xl border-[1.5px] bg-card p-4',
				isCurrent
					? 'border-foreground'
					: isFeatured
						? 'border-brand/40 shadow-md'
						: 'border-border',
			)}
		>
			{isFeatured && (
				<span className="absolute -top-2.5 left-3.5 rounded-md bg-foreground px-2 py-0.5 text-[9px] font-bold tracking-[0.07em] text-background">
					MOST POPULAR
				</span>
			)}
			<span className="text-[10.5px] font-bold tracking-[0.07em] text-muted-foreground">
				{tier.name.toUpperCase()}
			</span>
			<span className="flex items-baseline gap-1">
				<span className="text-[22px] font-bold tracking-tight text-foreground">{amount}</span>
				{per && <span className="text-[11px] text-muted-foreground">{per}</span>}
			</span>
			<p className="text-[11.5px] leading-relaxed text-muted-foreground">{tier.tagline}</p>
			<ul className="flex flex-1 flex-col gap-1.5 pt-0.5">
				{tier.features.map((feature) => (
					<li
						key={feature}
						className="flex gap-2 text-[11.5px] leading-snug text-secondary-foreground"
					>
						<Check size={11} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" />
						<span>{feature}</span>
					</li>
				))}
			</ul>
			<PlanCardAction
				tier={tier}
				isCurrent={isCurrent}
				isSold={isSold}
				isFeatured={!!isFeatured}
				onChoosePlan={onChoosePlan}
			/>
		</div>
	)
}

function PlanCardAction({
	tier,
	isCurrent,
	isSold,
	isFeatured,
	onChoosePlan,
}: {
	tier: BillingPlanTier
	isCurrent: boolean
	isSold: boolean
	isFeatured: boolean
	onChoosePlan: () => void
}) {
	if (isCurrent) {
		return (
			<Button variant="outline" disabled className="w-full">
				Current plan
			</Button>
		)
	}
	if (isSold) {
		return (
			<Button
				variant={isFeatured ? 'default' : 'outline'}
				onClick={onChoosePlan}
				className="w-full"
			>
				Choose {tier.name}
			</Button>
		)
	}
	// Not self-serve on this instance — Enterprise never is, and a tier this
	// instance does not sell has no price here to charge.
	return (
		<Button
			variant="outline"
			disabled
			className="w-full"
			title={
				tier.contactOnly
					? 'Enterprise is arranged directly — talk to us.'
					: 'This instance does not sell this plan through checkout — talk to us to switch.'
			}
		>
			Contact sales
		</Button>
	)
}

function AccountDisclosure({
	workspaceId,
	plan,
	configured,
	invoiceEmail,
	// No per-invoice Download in v1 — a product decision, not a missing feature.
	// The invoices table carries only a stripePaymentIntentId, so there is no
	// hosted URL or PDF to link; adding one means a backend change first.
	invoices,
}: {
	workspaceId: string
	plan: BillingPlanResponse
	configured: boolean
	invoiceEmail: string | null
	invoices: BillingInvoiceResponse[]
}) {
	const portal = useOpenPortal(workspaceId)
	const [open, setOpen] = useState(invoices.length > 0)

	const summary =
		invoices.length === 0
			? 'no invoices yet'
			: `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`

	// A Stripe Customer is created only after a payment succeeds, so an active
	// plan is the only state in which a card is provably on file.
	const hasCardOnFile = plan.status === 'active'

	const planLabel = plan.planLabel ?? plan.planId
	const detailRows: {
		key: string
		value: string
		action?: { label: string; onClick: () => void }
	}[] = [
		{
			key: 'Billing email',
			value: invoiceEmail ?? 'Not set',
			action: { label: 'Edit', onClick: () => portal.mutate() },
		},
		{
			key: 'Plan',
			value:
				plan.priceCents !== null
					? `${planLabel} · ${formatAmount(plan.priceCents, plan.currency)} / month`
					: planLabel,
			action: { label: 'Edit', onClick: () => portal.mutate() },
		},
		...(plan.nextChargeAt
			? [{ key: 'Next charge', value: INVOICE_DATE_FORMAT.format(new Date(plan.nextChargeAt)) }]
			: []),
	]

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-4">
			<CollapsibleTrigger className="flex w-full items-center gap-3 text-left transition-opacity hover:opacity-70">
				<span className="min-w-0 flex-1">
					<span className="block text-[12.5px] font-semibold text-foreground">
						Payment, details and invoices
					</span>
					<span className="block text-xs text-muted-foreground">{summary}</span>
				</span>
				<span className="shrink-0 text-xs font-semibold text-muted-foreground">
					{open ? 'Hide' : 'Show'}
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-4">
				<div className="flex flex-col gap-6">
					<div className="grid gap-6 md:grid-cols-2">
						<div>
							<h3 className="settings-label mb-2.5">PAYMENT METHOD</h3>
							{/* Two states (mockup 2894–2905). A Stripe Customer — and therefore
							    a charged card — exists only once a payment succeeded, so an
							    active plan is the card-present state. The brand tile, •••• last4
							    and expiry stay out: the summary endpoint returns no
							    payment-method fields, and a plausible-looking card would be a
							    fabrication. */}
							{hasCardOnFile ? (
								<div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
									<p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground sm:min-w-[180px]">
										A card is on file with Stripe for this workspace. Stripe holds it — Maskin never
										stores your card number.
									</p>
									<Button
										variant="outline"
										className="shrink-0"
										disabled={!configured || portal.isPending}
										onClick={() => portal.mutate()}
									>
										Update
									</Button>
								</div>
							) : (
								<div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-input bg-muted/30 p-4">
									<p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground sm:min-w-[180px]">
										No card on file. Stripe handles the payment — Maskin never stores your card
										number.
									</p>
									<Button
										className="shrink-0"
										disabled={!configured || portal.isPending}
										onClick={() => portal.mutate()}
									>
										Manage card
									</Button>
								</div>
							)}
						</div>

						<div>
							<h3 className="settings-label mb-2.5">BILLING DETAILS</h3>
							{/* A repeating row list (mockup 2911–2916). Every row is a field the
							    summary endpoint returns — company, VAT and address live only in
							    Stripe, so they are not listed here. */}
							<div className="rounded-xl border border-border px-4">
								{detailRows.map((row) => (
									<div
										key={row.key}
										className="flex items-center gap-3 border-b border-border py-1.5 last:border-b-0"
									>
										<span className="w-[88px] shrink-0 text-xs text-muted-foreground">
											{row.key}
										</span>
										<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
											{row.value}
										</span>
										{row.action && (
											<Button
												variant="ghost"
												size="sm"
												className="shrink-0 text-muted-foreground"
												disabled={!configured || portal.isPending}
												onClick={row.action.onClick}
											>
												{row.action.label}
											</Button>
										)}
									</div>
								))}
							</div>
						</div>
					</div>

					<div>
						<h3 className="settings-label mb-2.5">INVOICES</h3>
						{invoices.length === 0 ? (
							<div className="rounded-xl border border-border bg-muted/30">
								<EmptyState
									title="No invoices yet"
									description="The first one arrives the day the subscription starts."
									className="py-6"
								/>
							</div>
						) : (
							<div className="overflow-x-auto rounded-xl border border-border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Date</TableHead>
											<TableHead>Description</TableHead>
											<TableHead className="text-right">Amount</TableHead>
											<TableHead>Status</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{invoices.map((invoice) => (
											<TableRow key={invoice.id}>
												<TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
													{INVOICE_DATE_FORMAT.format(new Date(invoice.billedAt))}
												</TableCell>
												<TableCell className="min-w-0 max-w-[160px] truncate sm:max-w-[300px]">
													{invoice.description}
												</TableCell>
												<TableCell className="whitespace-nowrap text-right">
													{formatAmount(invoice.amountCents, invoice.currency)}
												</TableCell>
												<TableCell>
													<StatusBadge status={invoice.status} />
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</div>

					<div className="flex flex-wrap items-center gap-4 pb-2">
						<p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground sm:min-w-[240px]">
							Payments and invoicing run on Stripe. Card details never touch Maskin's servers.
						</p>
						{plan.status === 'active' && (
							<Button
								variant="ghost"
								size="sm"
								className="shrink-0 text-error hover:text-error"
								disabled={!configured || portal.isPending}
								onClick={() => portal.mutate()}
							>
								Cancel subscription
							</Button>
						)}
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function CheckoutDialog({
	open,
	onOpenChange,
	workspaceId,
	publishableKey,
	plan,
	currentEmail,
	testMode,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	publishableKey: string
	plan: BillingPlanResponse
	currentEmail: string | null
	testMode: boolean
}) {
	const { workspace } = useWorkspace()
	const startCheckout = useStartCheckout(workspaceId)
	const [email, setEmail] = useState(currentEmail ?? '')
	const [serverError, setServerError] = useState<string | null>(null)

	const planLabel = plan.planLabel ?? plan.planId
	const price = formatAmount(plan.priceCents, plan.currency)

	useEffect(() => {
		if (open) {
			setEmail(currentEmail ?? '')
			setServerError(null)
		}
	}, [open, currentEmail])

	useEffect(() => {
		if (open) {
			startCheckout.mutate(undefined, {
				onError: (err) =>
					setServerError(err instanceof Error ? err.message : 'Could not start checkout'),
			})
		} else {
			// Drop the consumed client secret so reopening starts a fresh checkout
			// instead of remounting Elements on an already-used PaymentIntent.
			startCheckout.reset()
		}
		// New PaymentIntent per open — never reuse a confirmed intent's secret.
	}, [open, startCheckout.mutate, startCheckout.reset])

	const stripePromise = useMemo(() => loadStripe(publishableKey), [publishableKey])
	const clientSecret = startCheckout.data?.clientSecret ?? null

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>
						{plan.status === 'active' ? `Switch to ${planLabel}` : `Subscribe to ${planLabel}`}
					</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Billing for {workspace?.name ?? 'this workspace'}. Change or cancel any time.
						{testMode ? ' Test mode: use the Stripe test card 4242 4242 4242 4242.' : ''}
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				<div className="space-y-4">
					{/* Order summary (mockup 3018–3031), reduced to the lines the API
					    actually returns — there is no included-usage or overage field, and
					    the plan chooser (3021–3023) has nothing to choose between: the
					    instance resolves exactly one plan from STRIPE_PRICE_ID. */}
					<div className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-3">
						<div className="flex items-center gap-3 text-xs">
							<span className="min-w-0 flex-1 text-muted-foreground">Subscription</span>
							<span className="font-semibold text-foreground">{price} / month</span>
						</div>
						<div className="h-px bg-border" />
						<div className="flex items-baseline gap-3">
							<span className="flex-1 text-[12.5px] font-semibold text-foreground">Due today</span>
							<span className="text-[17px] font-bold tracking-tight text-foreground">{price}</span>
						</div>
						{/* Terms fine print (mockup 3030), restricted to what the checkout
						    actually does: one PaymentIntent now, everything after it on
						    Stripe. No renewal or included-usage claim — neither is modelled. */}
						<p className="text-[11px] leading-relaxed text-muted-foreground">
							One charge of {price} today. Your plan, card and any future charges are managed on
							Stripe.
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="billing-invoice-email">Invoice email</Label>
						<Input
							id="billing-invoice-email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="billing@yourteam.com"
						/>
					</div>

					{clientSecret && stripePromise ? (
						<Elements stripe={stripePromise} options={{ clientSecret }}>
							<CheckoutForm
								clientSecret={clientSecret}
								email={email}
								workspaceId={workspaceId}
								price={price}
								onCancel={() => onOpenChange(false)}
								onPaid={() => onOpenChange(false)}
							/>
						</Elements>
					) : (
						<output className="flex items-center gap-2 text-sm text-muted-foreground">
							<Spinner className="size-4" />
							Preparing secure checkout…
						</output>
					)}

					{/* The checkout failure and the Stripe reassurance are two different
					    statements — sharing one <p> rendered them as a run-on sentence. */}
					<p aria-live="polite" className="text-sm text-error empty:hidden">
						{serverError}
					</p>
					<p className="text-center text-xs leading-relaxed text-muted-foreground">
						Secured by Stripe. Maskin never sees or stores your card number.
					</p>
				</div>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

function CheckoutForm({
	clientSecret,
	email,
	workspaceId,
	price,
	onCancel,
	onPaid,
}: {
	clientSecret: string
	email: string
	workspaceId: string
	price: string
	onCancel: () => void
	onPaid: () => void
}) {
	const stripe = useStripe()
	const elements = useElements()
	const complete = useCompleteCheckout(workspaceId)
	const [error, setError] = useState<string | null>(null)
	const [paying, setPaying] = useState(false)
	// An intent confirmPayment produced whose status was not yet 'succeeded'.
	// Retrying confirms the *completed* payment instead of running confirmPayment
	// again — Stripe rejects confirming the same intent twice.
	const [confirmedIntentId, setConfirmedIntentId] = useState<string | null>(null)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!stripe || !elements) return

		// Validate email client-side before any charge: an invalid address would
		// fail on /complete *after* the payment succeeded, leaving the user
		// charged with no way to finish.
		const trimmedEmail = email.trim()
		if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
			setError('Enter a valid invoice email, or leave it blank to skip invoices.')
			return
		}

		setPaying(true)
		setError(null)

		try {
			let intentId = confirmedIntentId
			if (!intentId) {
				const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
					elements,
					clientSecret,
					confirmParams: { return_url: window.location.href },
					redirect: 'if_required',
				})

				if (confirmError) {
					setError(confirmError.message ?? 'Payment failed. Please try again.')
					setPaying(false)
					return
				}

				if (paymentIntent?.status !== 'succeeded') {
					// Keep the intent so a retry completes it rather than charging twice.
					setConfirmedIntentId(paymentIntent?.id ?? null)
					setError('Payment is still processing. Check the payment status and try again.')
					setPaying(false)
					return
				}
				intentId = paymentIntent.id
			}

			await complete.mutateAsync({
				paymentIntentId: intentId,
				invoiceEmail: trimmedEmail || undefined,
			})
			onPaid()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not confirm your payment.')
			setPaying(false)
		}
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			{/* The mockup's NAME ON CARD / COUNTRY / POSTAL CODE fields (3046–3062)
			    are not re-created here: PaymentElement collects cardholder billing
			    details itself where the payment method needs them, and a card-owner
			    field outside the Element would put card data on our page. */}
			<PaymentElement />
			<p aria-live="polite" className="text-sm text-error">
				{error}
			</p>
			<ResponsiveDialogFooter>
				<Button type="button" variant="ghost" onClick={onCancel} disabled={paying}>
					Cancel
				</Button>
				<Button type="submit" disabled={!stripe || paying}>
					{paying && <Spinner className="size-4" />}
					{paying ? 'Processing…' : `Subscribe · ${price} / month`}
				</Button>
			</ResponsiveDialogFooter>
		</form>
	)
}
