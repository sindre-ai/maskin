import { PlanPicker } from '@/components/billing/plan-picker'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useBillingUsage, useStripeCheckout } from '@/hooks/use-billing'
import { ApiError, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { welcomeLandingPath } from '@/lib/welcome-landing'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { type Stripe, loadStripe } from '@stripe/stripe-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

// The card step of sign-up (bet "A card to start a 7-day trial"). A workspace made through it
// waits here until a card is saved with Stripe, with no charge. The server only creates such a
// workspace while the trial-card-percent flag is on, so with the flag off nobody lands here.
export const Route = createFileRoute('/_authed/start-trial/$workspaceId')({
	component: StartTrialPage,
})

type Step =
	| { kind: 'form' }
	| { kind: 'declined' }
	| { kind: 'used' }
	| { kind: 'failed'; message: string }
	| { kind: 'done' }

function StartTrialPage() {
	const { workspaceId } = Route.useParams()
	const queryClient = useQueryClient()
	const { data: usage, isPending: usagePending } = useBillingUsage(workspaceId)
	const [step, setStep] = useState<Step>({ kind: 'form' })
	// Bumped for a new card form: a finished card setup cannot be reused, so trying another card
	// needs a fresh one.
	const [attempt, setAttempt] = useState(0)
	const [pickerOpen, setPickerOpen] = useState(false)

	const waiting = usage?.trial_state === 'awaiting_card'
	const setup = useQuery({
		// Not under the usage key: refetching usage must not mint another card setup.
		queryKey: ['billing', 'trial-setup', workspaceId, attempt],
		queryFn: () => api.billing.trial.setup(workspaceId),
		enabled: waiting,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		retry: false,
	})

	const publishableKey = setup.data?.publishable_key
	const stripePromise = useMemo<Promise<Stripe | null> | null>(
		() => (publishableKey ? loadStripe(publishableKey) : null),
		[publishableKey],
	)

	// A workspace that never needed a card has nothing to do here.
	useEffect(() => {
		if (usagePending || !usage || usage.trial_state !== null) return
		void welcomeLandingPath(workspaceId).then((path) => window.location.assign(path))
	}, [usage, usagePending, workspaceId])

	const openMaskin = async () => {
		window.location.assign(await welcomeLandingPath(workspaceId))
	}

	const started = step.kind === 'done' || usage?.trial_state === 'started'

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">
				{started ? (
					<div className="space-y-6 text-center">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight">Your trial has started</h1>
							<p className="mt-1 text-sm text-muted-foreground">
								You have 7 days. We show how much of your plan you have used, so you can pick a plan
								before it runs out.
							</p>
						</div>
						<Button className="w-full" onClick={openMaskin}>
							Open Maskin
						</Button>
					</div>
				) : (
					<>
						<div className="text-center">
							<h1 className="text-2xl font-semibold tracking-tight">Start your 7-day trial</h1>
							<p className="mt-1 text-sm text-muted-foreground">
								Add a card to begin. Nothing is charged today. When the trial ends, you pick a plan
								or stop.
							</p>
						</div>

						{step.kind === 'used' && (
							<div
								role="alert"
								className="space-y-2 rounded-lg border border-ask-border bg-ask-surface px-3.5 py-3 text-[12.5px] leading-[1.55] text-foreground"
							>
								<p className="font-semibold">This card has already started a free trial.</p>
								<p>Choose a plan to keep going, or add a different card.</p>
								<Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
									Choose a plan
								</Button>
							</div>
						)}

						{!waiting || setup.isPending ? (
							<div className="flex justify-center py-6" aria-busy="true">
								{usagePending || waiting ? <Spinner /> : null}
							</div>
						) : setup.isError || !stripePromise || !setup.data ? (
							<p role="alert" className="text-center text-xs text-error">
								We could not open the card form. Reload the page to try again.
							</p>
						) : (
							<Elements
								key={attempt}
								stripe={stripePromise}
								options={{ clientSecret: setup.data.client_secret }}
							>
								<CardForm
									workspaceId={workspaceId}
									step={step}
									onStep={setStep}
									onUsed={() => {
										setStep({ kind: 'used' })
										setAttempt((n) => n + 1)
									}}
									onDone={() => {
										setStep({ kind: 'done' })
										void queryClient.invalidateQueries({
											queryKey: queryKeys.billing.usage(workspaceId),
										})
									}}
								/>
							</Elements>
						)}

						<p className="text-center text-xs text-muted-foreground">
							We allow one free trial per card.
						</p>
					</>
				)}
			</div>
			<ChoosePlanDialog workspaceId={workspaceId} open={pickerOpen} onOpenChange={setPickerOpen} />
		</div>
	)
}

// "Choose a plan" from the card already used notice: the person keeps their account and can pay
// for a plan instead of using another card. Checkout returns to Billing.
function ChoosePlanDialog({
	workspaceId,
	open,
	onOpenChange,
}: {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const checkout = useStripeCheckout(workspaceId)
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Choose a plan</DialogTitle>
					<DialogDescription>Pick a plan to keep going without a free trial.</DialogDescription>
				</DialogHeader>
				<PlanPicker
					current="trial"
					pending={checkout.isPending}
					onContinue={(plan) => {
						const base = `${window.location.origin}/${workspaceId}/settings/billing`
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
					}}
				/>
				{checkout.isError && <p className="text-xs text-error">{checkout.error.message}</p>}
			</DialogContent>
		</Dialog>
	)
}

function CardForm({
	workspaceId,
	step,
	onStep,
	onUsed,
	onDone,
}: {
	workspaceId: string
	step: Step
	onStep: (step: Step) => void
	onUsed: () => void
	onDone: () => void
}) {
	const stripe = useStripe()
	const elements = useElements()
	const [saving, setSaving] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!stripe || !elements || saving) return
		setSaving(true)
		onStep({ kind: 'form' })
		try {
			const { error, setupIntent } = await stripe.confirmSetup({
				elements,
				redirect: 'if_required',
				confirmParams: { return_url: window.location.href },
			})
			if (error) {
				// A card Stripe refused. Incomplete or mistyped fields show inline in the field.
				if (error.type === 'card_error') onStep({ kind: 'declined' })
				else if (error.type !== 'validation_error') {
					onStep({ kind: 'failed', message: error.message ?? 'Something went wrong.' })
				}
				return
			}
			if (!setupIntent) {
				onStep({ kind: 'failed', message: 'Something went wrong.' })
				return
			}
			await api.billing.trial.start(workspaceId, setupIntent.id)
			onDone()
		} catch (err) {
			if (err instanceof ApiError && err.code === 'TRIAL_CARD_ALREADY_USED') {
				onUsed()
			} else {
				onStep({
					kind: 'failed',
					message: err instanceof Error ? err.message : 'Something went wrong.',
				})
			}
		} finally {
			setSaving(false)
		}
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div>
				<Label className="mb-1 text-muted-foreground">Card</Label>
				<PaymentElement options={{ readOnly: saving }} />
			</div>

			{step.kind === 'declined' && (
				<p role="alert" className="text-xs text-error">
					Your card was declined. Check the details or try another card.
				</p>
			)}
			{step.kind === 'failed' && (
				<p role="alert" className="text-xs text-error">
					{step.message}
				</p>
			)}

			<Button type="submit" disabled={!stripe || !elements || saving} className="w-full">
				{saving ? 'Starting trial...' : 'Start 7-day trial'}
			</Button>
		</form>
	)
}
