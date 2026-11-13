import { cn } from '@/lib/cn'
import type { EmailRhythm } from '@maskin/shared'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'

export type EmailChoice = EmailRhythm | 'off'

const OPTIONS: { value: EmailChoice; label: string }[] = [
	{ value: 'daily', label: 'Daily' },
	{ value: 'weekly', label: 'Weekly' },
	{ value: 'off', label: 'Off' },
]

/** What the row shows: Off when the email switch is off, otherwise the saved rhythm. */
export function emailChoice(enabled: boolean, rhythm: EmailRhythm): EmailChoice {
	return enabled ? rhythm : 'off'
}

/**
 * How often the summary email comes: Daily, Weekly or Off (v3 mockup, Digests). Off is the same
 * setting as the email switch on the Digests row above, so the two always agree.
 */
export function EmailRhythmRow({
	value,
	onChange,
}: {
	value: EmailChoice
	onChange: (next: EmailChoice) => void
}) {
	return (
		<div className="flex flex-col gap-3 px-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
			<div className="min-w-0">
				<span className="block text-[15px] font-medium leading-tight">Summary email</span>
				<span className="block text-[13px] text-muted-foreground">
					One email with what your agents did and what waits on you.
				</span>
			</div>
			<RadioGroupPrimitive.Root
				value={value}
				onValueChange={(next) => onChange(next as EmailChoice)}
				aria-label="How often the summary email comes"
				className="flex shrink-0 rounded-full bg-secondary p-0.5"
			>
				{OPTIONS.map((option) => (
					<RadioGroupPrimitive.Item
						key={option.value}
						value={option.value}
						className={cn(
							'min-w-16 flex-1 rounded-full px-3 py-1 text-[13px] font-medium text-muted-foreground transition-colors sm:flex-none',
							'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							'data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm',
						)}
					>
						{option.label}
					</RadioGroupPrimitive.Item>
				))}
			</RadioGroupPrimitive.Root>
		</div>
	)
}
