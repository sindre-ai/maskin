import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
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
import { useBuyCredits } from '@/hooks/use-billing'
import { cn } from '@/lib/cn'
import {
	CREDIT_TOPUP_MAX_USD,
	CREDIT_TOPUP_MIN_USD,
	CREDIT_TOPUP_SUGGESTED_USD,
} from '@maskin/shared'
import { useEffect, useState } from 'react'

interface BuyCreditsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
}

export function BuyCreditsDialog({ open, onOpenChange, workspaceId }: BuyCreditsDialogProps) {
	const buyCredits = useBuyCredits(workspaceId)
	const [amountUsd, setAmountUsd] = useState<number>(CREDIT_TOPUP_SUGGESTED_USD[1])

	// Reset to the default preset + clear any prior error each time the dialog opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mutation handle is stable; including it would rerun this on every render
	useEffect(() => {
		if (open) {
			setAmountUsd(CREDIT_TOPUP_SUGGESTED_USD[1])
			buyCredits.reset()
		}
	}, [open])

	const valid =
		Number.isFinite(amountUsd) &&
		amountUsd >= CREDIT_TOPUP_MIN_USD &&
		amountUsd <= CREDIT_TOPUP_MAX_USD

	const handleBuy = () => {
		if (!valid) return
		const base = window.location.href.split('?')[0]
		buyCredits.mutate(
			{
				amount_usd_cents: Math.round(amountUsd * 100),
				success_url: `${base}?billing=credit_success`,
				cancel_url: `${base}?billing=credit_cancel`,
			},
			{
				onSuccess: ({ url }) => {
					window.location.href = url
				},
			},
		)
	}

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Buy usage credits</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Prepay a balance that's drawn down once you go past your plan's included tokens. No
						auto-billing — you choose when to top up.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				<div className="space-y-3">
					<div className="flex flex-wrap gap-2">
						{CREDIT_TOPUP_SUGGESTED_USD.map((preset) => (
							<Button
								key={preset}
								type="button"
								size="sm"
								variant={amountUsd === preset ? 'default' : 'outline'}
								onClick={() => setAmountUsd(preset)}
							>
								${preset}
							</Button>
						))}
					</div>

					<div>
						<Label htmlFor="credit-amount" className="mb-1">
							Custom amount (USD)
						</Label>
						<Input
							id="credit-amount"
							type="number"
							min={CREDIT_TOPUP_MIN_USD}
							max={CREDIT_TOPUP_MAX_USD}
							step={1}
							value={amountUsd}
							onChange={(e) => setAmountUsd(e.target.valueAsNumber)}
							className={cn(!valid && 'border-error')}
						/>
						<p className="mt-1 text-xs text-muted-foreground">
							${CREDIT_TOPUP_MIN_USD}–${CREDIT_TOPUP_MAX_USD}
						</p>
					</div>

					<FormError
						error={
							buyCredits.isError
								? (buyCredits.error?.message ?? 'Could not start checkout.')
								: undefined
						}
					/>
				</div>

				<ResponsiveDialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={buyCredits.isPending}
					>
						Cancel
					</Button>
					<Button onClick={handleBuy} disabled={!valid || buyCredits.isPending}>
						{buyCredits.isPending
							? 'Redirecting…'
							: `Buy $${Number.isFinite(amountUsd) ? amountUsd : 0}`}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
