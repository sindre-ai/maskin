import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { PAID_PLANS, PLAN_PRICE_DKK, type PaidPlan, formatKroner } from '@maskin/shared'
import { useState } from 'react'

export const PLAN_NAME: Record<PaidPlan, string> = {
	starter: 'Starter',
	pro: 'Pro',
	team: 'Team',
	ultra: 'Ultra',
}

/**
 * The four paid plans as a radio group of prices in kroner, with one button for
 * the selected plan. Price only: the included usage is not shown here (design
 * spec D2). Prices come from `PLAN_PRICE_DKK` in `@maskin/shared`.
 */
export function PlanPicker({
	current,
	pending,
	onContinue,
}: {
	/** The plan the workspace is on now, preselected. Anything else starts on Pro. */
	current: string
	pending: boolean
	onContinue: (plan: PaidPlan) => void
}) {
	const [selected, setSelected] = useState<PaidPlan>(
		(PAID_PLANS as readonly string[]).includes(current) ? (current as PaidPlan) : 'pro',
	)

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">Prices are per month, excluding VAT.</p>
			<RadioGroup
				value={selected}
				onValueChange={(value) => setSelected(value as PaidPlan)}
				aria-label="Choose a plan"
			>
				{PAID_PLANS.map((plan) => (
					<Label
						key={plan}
						htmlFor={`plan-picker-${plan}`}
						className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-sm has-[[data-state=checked]]:border-primary"
					>
						<span className="flex items-center gap-3">
							<RadioGroupItem id={`plan-picker-${plan}`} value={plan} />
							<span className="font-medium">{PLAN_NAME[plan]}</span>
						</span>
						<span className="text-muted-foreground">{formatKroner(PLAN_PRICE_DKK[plan])}</span>
					</Label>
				))}
			</RadioGroup>
			<Button className="w-full" onClick={() => onContinue(selected)} disabled={pending}>
				{pending ? 'Opening checkout…' : `Continue with ${PLAN_NAME[selected]}`}
			</Button>
		</div>
	)
}
