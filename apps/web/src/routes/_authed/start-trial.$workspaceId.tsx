import { PlanPicker } from '@/components/billing/plan-picker'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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

// A promo code the server said is valid. The page never decides that: starting the trial sends the
// code again and the server checks it again.
type Promo = { kind: 'none' } | { kind: 'applied'; code: string; trialDays: number }

// A card starts the 7 day trial; a promo code starts the length the server said it carries.
const CARD_TRIAL_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

function StartTrialPage() {
	const { workspaceId } = Route.useParams()
	const queryClient = useQueryClient()
	const { data: usage, isPending: usagePending } = useBillingUsage(workspaceId)
	const [step, setStep] = useState<Step>({ kind: 'form' })
	// Bumped for a new card form: a finished card setup cannot be reused, so trying another card
	// needs a fresh one.
	const [attempt, setAttempt] = useState(0)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [promo, setPromo] = useState<Promo>({ kind: 'none' })

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
	const trialDays = promo.kind === 'applied' ? promo.trialDays : CARD_TRIAL_DAYS
	// Once started, the days come from the clock the server set, so a code trial says 14.
	const startedDays =
		usage?.trial_state === 'started' && usage.period_resets_in_ms
			? Math.ceil(usage.period_resets_in_ms / DAY_MS)
			: trialDays

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">
				{started ? (
					<div className="space-y-6 text-center">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight">Your trial has started</h1>
							<p className="mt-1 text-sm text-muted-foreground">
								You have {startedDays} days. We show how much of your plan you have used, so you can
								pick a plan before it runs out.
							</p>
						</div>
						<Button className="w-full" onClick={openMaskin}>
							Open Maskin
						</Button>
					</div>
				) : (
					<>
						<div className="text-center">
							<h1 className="text-2xl font-semibold tracking-tight">
								Start your {trialDays}-day trial
							</h1>
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

						{waiting && (
							<PromoCodeBox
								workspaceId={workspaceId}
								promo={promo}
								onPromo={setPromo}
								onDone={() => {
									setStep({ kind: 'done' })
									void queryClient.invalidateQueries({
										queryKey: queryKeys.billing.usage(workspaceId),
									})
								}}
							/>
						)}

						{promo.kind === 'applied' ? null : !waiting || setup.isPending ? (
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

						{promo.kind === 'none' && (
							<p className="text-center text-xs text-muted-foreground">
								We allow one free trial per card.
							</p>
						)}
					</>
				)}
			</div>
			<ChoosePlanDialog workspaceId={workspaceId} open={pickerOpen} onOpenChange={setPickerOpen} />
		</div>
	)
}

// The Promo code field above the card form. Apply asks the server; a valid code folds the card form
// away (the page hides it) and shows the Start button that needs no card. Remove opens it again.
function PromoCodeBox({
	workspaceId,
	promo,
	onPromo,
	onDone,
}: {
	workspaceId: string
	promo: Promo
	onPromo: (promo: Promo) => void
	onDone: () => void
}) {
	const [value, setValue] = useState('')
	const [checking, setChecking] = useState(false)
	const [starting, setStarting] = useState(false)
	const [message, setMessage] = useState<string | null>(null)

	const messageFor = (err: unknown) => {
		if (err instanceof ApiError && err.status === 429) {
			return 'Too many tries. Wait a minute and try again.'
		}
		return err instanceof Error ? err.message : 'Something went wrong.'
	}

	const apply = async (e: React.FormEvent) => {
		e.preventDefault()
		const code = value.trim()
		if (!code || checking) return
		setChecking(true)
		setMessage(null)
		try {
			const { valid, trial_days } = await api.billing.trial.checkPromo(workspaceId, code)
			if (valid && trial_days) onPromo({ kind: 'applied', code, trialDays: trial_days })
			else setMessage('This promo code is not valid, or it has been used up.')
		} catch (err) {
			setMessage(messageFor(err))
		} finally {
			setChecking(false)
		}
	}

	const remove = () => {
		onPromo({ kind: 'none' })
		setValue('')
		setMessage(null)
	}

	const start = async () => {
		if (promo.kind !== 'applied' || starting) return
		setStarting(true)
		setMessage(null)
		try {
			await api.billing.trial.startWithPromo(workspaceId, promo.code)
			onDone()
		} catch (err) {
			if (err instanceof ApiError && err.code === 'TRIAL_PROMO_CODE_INVALID') {
				// The code was used up or expired between Apply and Start: the card form comes back.
				onPromo({ kind: 'none' })
				setMessage('This promo code is no longer valid. Add a card to start your trial.')
			} else {
				setMessage(messageFor(err))
			}
		} finally {
			setStarting(false)
		}
	}

	if (promo.kind === 'applied') {
		return (
			<div className="space-y-4">
				<div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3 text-[12.5px] leading-[1.55]">
					<div>
						<p>Promo code applied, no card needed.</p>
						<p className="text-muted-foreground">Your trial lasts {promo.trialDays} days.</p>
					</div>
					<Button size="sm" variant="ghost" onClick={remove} disabled={starting}>
						Remove
					</Button>
				</div>
				{message && (
					<p role="alert" className="text-xs text-error">
						{message}
					</p>
				)}
				<Button className="w-full" onClick={start} disabled={starting}>
					{starting ? 'Starting trial...' : `Start ${promo.trialDays}-day trial`}
				</Button>
			</div>
		)
	}

	return (
		<form onSubmit={apply} className="space-y-1.5">
			<Label htmlFor="promo-code" className="text-muted-foreground">
				Promo code
			</Label>
			<div className="flex gap-2">
				<Input
					id="promo-code"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					autoComplete="off"
					autoCapitalize="characters"
					spellCheck={false}
					maxLength={100}
				/>
				<Button type="submit" variant="outline" disabled={!value.trim() || checking}>
					{checking ? 'Checking...' : 'Apply'}
				</Button>
			</div>
			{message && (
				<p role="alert" className="text-xs text-error">
					{message}
				</p>
			)}
		</form>
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
