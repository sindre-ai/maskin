import { cn } from '@/lib/cn'
import { Check } from 'lucide-react'

export type ConnectStepperStatus = 'done' | 'active' | 'pending'

export interface ConnectStepperStep {
	label: string
	status: ConnectStepperStatus
}

interface ConnectStepperProps {
	steps: ConnectStepperStep[]
	className?: string
}

// Horizontal 4-step indicator used inside the connect dialogs (the Resend
// self-serve flow is the first caller). Landed in `shared/` because the same
// shape is the right answer for any future >2-step connect flow — see the
// design spec on the parent bet.
export function ConnectStepper({ steps, className }: ConnectStepperProps) {
	return (
		<ol aria-label="Connection progress" className={cn('flex items-center gap-2', className)}>
			{steps.map((step, index) => {
				const isLast = index === steps.length - 1
				const stepNumber = index + 1
				const statusText =
					step.status === 'done' ? 'completed' : step.status === 'active' ? 'active' : 'not started'
				return (
					<li
						key={step.label}
						aria-current={step.status === 'active' ? 'step' : undefined}
						className="flex items-center gap-2 min-w-0"
					>
						<div className="flex items-center gap-2 min-w-0">
							<span
								aria-hidden="true"
								className={cn(
									'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
									step.status === 'done' && 'bg-success text-white',
									step.status === 'active' &&
										'bg-primary text-primary-foreground ring-4 ring-primary/15',
									step.status === 'pending' &&
										'border border-border bg-muted text-muted-foreground',
								)}
							>
								{step.status === 'done' ? (
									<Check className="h-3.5 w-3.5" aria-hidden="true" />
								) : (
									stepNumber
								)}
							</span>
							<span className="sr-only">
								Step {stepNumber} of {steps.length}: {step.label}, {statusText}
							</span>
							<span
								className={cn(
									'hidden text-xs font-medium sm:inline-block truncate',
									step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground',
								)}
							>
								{step.label}
							</span>
						</div>
						{!isLast && (
							<span
								aria-hidden="true"
								className={cn(
									'h-px w-6 shrink-0 sm:w-10 transition-colors duration-150',
									step.status === 'done' ? 'bg-success' : 'bg-border',
								)}
							/>
						)}
					</li>
				)
			})}
		</ol>
	)
}
