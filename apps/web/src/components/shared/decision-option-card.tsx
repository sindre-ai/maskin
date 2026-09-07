import { cn } from '@/lib/cn'

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

/**
 * One answer, drawn as its own small card: what taking it means, then a
 * full-width bar that commits it. The recommended option is the filled dark
 * bar on the right (mockup's `o.rec`).
 *
 * Shared by the For You card and the object timeline. An ask that renders one
 * way in the feed and another way on the object it was posted to is two asks as
 * far as the reader is concerned, so both surfaces draw it from here.
 */
export function DecisionOptionCard({
	option,
	pending,
	disabled,
	onChoose,
}: {
	option: DecisionOption
	pending: boolean
	// Set while a sibling option is being posted, so the reader cannot answer
	// the same question twice while the first answer is still in flight.
	disabled?: boolean
	onChoose: () => void
}) {
	const recommended = Boolean(option.recommended)
	return (
		<div
			className={cn(
				'flex flex-col overflow-hidden rounded-[13px] border border-border bg-card transition-opacity duration-150 hover:opacity-100',
				recommended ? 'opacity-100' : 'opacity-[0.82]',
			)}
		>
			{option.consequences.length > 0 && (
				<div className="flex flex-col gap-1.5 px-[13px] pb-2.5 pt-[11px]">
					{option.consequences.map((consequence) => (
						<div
							key={consequence}
							className="flex gap-[7px] text-[11.5px] leading-[1.45] text-muted-foreground"
						>
							<span aria-hidden className="shrink-0 text-border">
								·
							</span>
							<span className="min-w-0 text-pretty">{consequence}</span>
						</div>
					))}
				</div>
			)}
			<button
				type="button"
				data-action-id={option.id}
				onClick={onChoose}
				disabled={pending || disabled}
				className={cn(
					'mt-auto flex min-h-11 items-center gap-2.5 px-3.5 py-2.5 text-right transition-[background,transform] duration-150 hover:opacity-90 active:scale-[0.985] disabled:cursor-not-allowed',
					recommended
						? 'bg-primary text-primary-foreground'
						: 'bg-card text-foreground hover:bg-secondary',
				)}
			>
				<span
					className={cn(
						'min-w-0 flex-1 text-right tracking-[-0.01em]',
						recommended ? 'text-[13.5px] font-bold' : 'text-[12.5px] font-semibold',
					)}
				>
					{pending ? `${option.label}…` : option.label}
				</span>
			</button>
		</div>
	)
}

/**
 * The options grid. Auto-fit so three options sit in a row on a wide object
 * page and stack at 375px without a breakpoint of their own.
 */
export function DecisionOptionGrid({ children }: { children: React.ReactNode }) {
	return (
		<div className="grid gap-[9px] [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
			{children}
		</div>
	)
}
