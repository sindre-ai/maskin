import { cn } from '@/lib/cn'
import type { SuggestedStep } from '@maskin/shared'
import { ArrowUp, Pencil } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface SuggestedStepsProps {
	steps: SuggestedStep[]
	/** Sends the step's prompt as the person's message. */
	onSendStep: (step: SuggestedStep, index: number) => void
	/** A send is in flight. */
	sending: boolean
	/** Fills the message box with the step's prompt and focuses it. */
	onPickStep: (prompt: string) => void
	/** The agent is not in this workspace, so a tap could only fail. */
	disabled?: boolean
}

/**
 * The intro's first steps as buttons, stacked at every width. An arrow-up step
 * sends its label as the person's message on one tap; a pencil step fills the
 * message box and sends nothing. What a send step sends is exactly what it
 * prints (the schema forces prompt equal to label), so a tap never puts words
 * in the person's mouth.
 */
export function SuggestedSteps({
	steps,
	onSendStep,
	sending,
	onPickStep,
	disabled = false,
}: SuggestedStepsProps) {
	// Set synchronously in the click handler: the optimistic message only exists
	// after an await, so a second tap in the same tick would otherwise post twice.
	const sentRef = useRef(false)
	useEffect(() => {
		// A failed send rolls the bubble back and the row comes back: tapping works again.
		if (!sending) sentRef.current = false
	}, [sending])

	const tap = (step: SuggestedStep, index: number) => {
		if (disabled) return
		if (step.action === 'fill') {
			onPickStep(step.prompt)
			return
		}
		if (sentRef.current || sending) return
		sentRef.current = true
		onSendStep(step, index)
	}

	return (
		<fieldset
			className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
			data-testid="suggested-steps"
		>
			<legend className="sr-only">Suggested first steps</legend>
			{steps.map((step, index) => {
				const sends = step.action === 'send'
				const Icon = sends ? ArrowUp : Pencil
				return (
					<button
						// Index as key: a fixed snapshot from one immutable message, and labels are
						// not guaranteed unique across a hand-written list.
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed snapshot, never reorders
						key={index}
						type="button"
						// One explicit name: "{label}, sends now" or "{label}…, fills the message box".
						aria-label={`${step.label}${sends ? '' : '…'}, ${sends ? 'sends now' : 'fills the message box'}`}
						disabled={disabled || (sends && sending)}
						onClick={() => tap(step, index)}
						className={cn(
							'flex min-h-11 w-full items-center gap-2.5 rounded-[9px] border border-border bg-card px-3 py-2 text-left text-[13px] font-medium text-foreground transition-[border-color,transform]',
							'hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985]',
							'disabled:pointer-events-none disabled:opacity-60',
						)}
					>
						<Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
						<span className="line-clamp-2 min-w-0">
							{step.label}
							{sends ? '' : '…'}
						</span>
					</button>
				)
			})}
		</fieldset>
	)
}
