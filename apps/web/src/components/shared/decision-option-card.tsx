import { Button } from '@/components/ui/button'

/**
 * One option of an agent's decision, as the reader taps it.
 *
 * Structurally identical to `CardAction` in `@/lib/foryou-card-kind`, restated
 * here so this component does not depend on the For You feed's item shape — the
 * object timeline renders the same options straight off a comment's `decision`
 * block, with no `UnreadItem` in sight.
 */
export interface DecisionOption {
	/** Stable id, emitted as `action_id` on `foryou_card_action`. */
	id: string
	label: string
	consequences: readonly string[]
	recommended?: boolean
}

/** "Suggested: Ship. Goes out tonight. No rollback." — the agent's reasons, kept to two. */
export function suggestedLine(options: readonly DecisionOption[]): string | null {
	const option = options.find((candidate) => candidate.recommended)
	if (!option) return null
	const reasons = option.consequences.slice(0, 2).map((line) => {
		const trimmed = line.trim()
		return trimmed.endsWith('.') ? trimmed : `${trimmed}.`
	})
	return [`Suggested: ${option.label}.`, ...reasons].join(' ')
}

/**
 * The answers to an ask, drawn the way the iOS card draws them (mockup v6): the
 * recommended option is one full-width dark bar with a small "Recommended" tag,
 * the rest share one quiet row beneath, and what the agent expects to happen
 * is one line of small print instead of a box of bullets per option.
 *
 * Shared by the For You card and the object timeline. An ask that renders one
 * way in the feed and another way on the object it was posted to is two asks as
 * far as the reader is concerned, so both surfaces draw it from here.
 */
export function DecisionOptions({
	options,
	pendingId,
	onChoose,
}: {
	options: readonly DecisionOption[]
	/** The option being posted. Every button is held until it settles, so the question cannot be answered twice. */
	pendingId: string | null
	onChoose: (option: DecisionOption) => void
}) {
	const primary = options.filter((option) => option.recommended)
	const others = options.filter((option) => !option.recommended)
	const line = suggestedLine(options)
	const label = (option: DecisionOption) =>
		pendingId === option.id ? `${option.label}…` : option.label

	return (
		<div className="flex flex-col gap-2">
			{primary.map((option) => (
				<Button
					key={option.id}
					type="button"
					data-action-id={option.id}
					disabled={pendingId !== null}
					onClick={() => onChoose(option)}
					className="h-auto min-h-12 w-full justify-between whitespace-normal rounded-xl px-4 py-3 text-left text-[14px] font-bold"
				>
					<span className="min-w-0">{label(option)}</span>
					{/* Out of the accessible name on purpose: the button is its label. */}
					<span aria-hidden className="shrink-0 text-[11px] font-semibold opacity-70">
						Recommended
					</span>
				</Button>
			))}
			{others.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{others.map((option) => (
						<Button
							key={option.id}
							type="button"
							variant="secondary"
							data-action-id={option.id}
							disabled={pendingId !== null}
							onClick={() => onChoose(option)}
							className="h-auto min-h-11 min-w-[8rem] flex-1 whitespace-normal rounded-xl px-3 py-2.5 text-center text-[13px] font-semibold"
						>
							{label(option)}
						</Button>
					))}
				</div>
			)}
			{line && <p className="text-[12px] leading-[1.45] text-muted-foreground">{line}</p>}
		</div>
	)
}
