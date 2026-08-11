import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { useWorkspace } from '@/lib/workspace-context'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { createFileRoute } from '@tanstack/react-router'
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

function BillingPage() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useBillingSummary(workspaceId)
	const [checkoutOpen, setCheckoutOpen] = useState(false)

	if (isLoading || !data) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		)
	}

	return (
		<div className="space-y-4">
			<PlanCard
				workspaceId={workspaceId}
				plan={data.plan}
				configured={data.configured}
				testMode={data.testMode}
				onChangePlan={() => setCheckoutOpen(true)}
			/>
			<InvoiceEmailCard email={data.invoiceEmail} />
			<InvoicesCard invoices={data.invoices} />

			{data.configured && data.publishableKey && (
				<CheckoutDialog
					open={checkoutOpen}
					onOpenChange={setCheckoutOpen}
					workspaceId={workspaceId}
					publishableKey={data.publishableKey}
					planLabel={data.plan.planLabel ?? data.plan.planId}
					currentEmail={data.invoiceEmail}
					testMode={data.testMode}
				/>
			)}
		</div>
	)
}

function PlanCard({
	workspaceId,
	plan,
	configured,
	testMode,
	onChangePlan,
}: {
	workspaceId: string
	plan: BillingPlanResponse
	configured: boolean
	testMode: boolean
	onChangePlan: () => void
}) {
	const portal = useOpenPortal(workspaceId)

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-2">
					<CardTitle>Current plan</CardTitle>
					<div className="flex items-center gap-2">
						<StatusBadge status={plan.status} />
						{testMode && (
							<span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
								Test mode
							</span>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-1">
						<p className="text-lg font-semibold text-foreground">{plan.planLabel ?? plan.planId}</p>
						<p className="text-sm text-muted-foreground">
							{plan.priceCents !== null
								? `${formatAmount(plan.priceCents, plan.currency)} / month`
								: 'No active subscription'}
							{plan.nextChargeAt ? (
								<span className="text-muted-foreground">
									{' '}
									· next charge <RelativeTime date={plan.nextChargeAt} />
								</span>
							) : null}
						</p>
					</div>
					<div className="flex shrink-0 gap-2">
						<Button
							variant="outline"
							disabled={!configured || portal.isPending}
							onClick={() => portal.mutate()}
						>
							{portal.isPending && <Spinner className="size-4" />}
							Manage on Stripe
						</Button>
						<Button onClick={onChangePlan} disabled={!configured}>
							Change plan
						</Button>
					</div>
				</div>
				{!configured && (
					<p
						aria-live="polite"
						className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
					>
						Stripe is not configured for this instance. Billing is disabled until the server is set
						up with Stripe keys.
					</p>
				)}
			</CardContent>
		</Card>
	)
}

function InvoiceEmailCard({ email }: { email: string | null }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Invoice email</CardTitle>
			</CardHeader>
			<CardContent>
				<p className="text-sm text-foreground">{email ?? 'Not set'}</p>
				<p className="mt-1 text-sm text-muted-foreground">
					Invoices are sent to this address. Card details are handled by Stripe inside its own
					secured frames — Maskin never stores payment data.
				</p>
			</CardContent>
		</Card>
	)
}

function InvoicesCard({ invoices }: { invoices: BillingInvoiceResponse[] }) {
	if (invoices.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Invoices</CardTitle>
				</CardHeader>
				<CardContent>
					<EmptyState
						title="No invoices yet"
						description="Your invoices will appear here once your first payment is confirmed."
					/>
				</CardContent>
			</Card>
		)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Invoices</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="overflow-x-auto">
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
									<TableCell className="whitespace-nowrap">
										<RelativeTime date={invoice.billedAt} />
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
			</CardContent>
		</Card>
	)
}

function CheckoutDialog({
	open,
	onOpenChange,
	workspaceId,
	publishableKey,
	planLabel,
	currentEmail,
	testMode,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	publishableKey: string
	planLabel: string
	currentEmail: string | null
	testMode: boolean
}) {
	const startCheckout = useStartCheckout(workspaceId)
	const [email, setEmail] = useState(currentEmail ?? '')
	const [serverError, setServerError] = useState<string | null>(null)

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
					<ResponsiveDialogTitle>Change plan</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Upgrade to {planLabel}
						{testMode ? ' — test mode: use the Stripe test card 4242 4242 4242 4242' : ''}. Your
						plan is activated as soon as the payment is confirmed.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				<div className="space-y-4">
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
								planLabel={planLabel}
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

					<p aria-live="polite" className="text-xs text-muted-foreground">
						{serverError} Payments are handled by Stripe inside its own secured frames — your card
						details never touch Maskin's servers.
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
	planLabel,
	onCancel,
	onPaid,
}: {
	clientSecret: string
	email: string
	workspaceId: string
	planLabel: string
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
					{paying ? 'Processing…' : `Pay for ${planLabel}`}
				</Button>
			</ResponsiveDialogFooter>
		</form>
	)
}
