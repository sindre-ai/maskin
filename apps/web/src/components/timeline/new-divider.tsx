/**
 * The unread boundary on the object timeline (mockup 1194–1204, D8).
 *
 * Copy is verbatim from the SPEC — `New — {N} items` on the left, `✓ Mark all
 * read` on the right — and the divider is focusable so a screen-reader user
 * can jump to the first unread comment below it. Callers hide the divider
 * entirely when `count === 0`; no reserved space, per SPEC.
 */
export function NewDivider({
	count,
	onMarkRead,
}: {
	count: number
	onMarkRead: () => void
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: <hr> can't host the pill + Mark-all-read button; ARIA separator role fits, per D8 SPEC.
		<div
			role="separator"
			aria-label={`${count} unread items below`}
			tabIndex={0}
			className="relative z-[3] flex items-center gap-2.5 pb-1.5 pt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
		>
			<span aria-hidden="true" className="h-px w-3 bg-brand/40" />
			<span className="rounded-full bg-brand/10 px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.11em] text-brand">
				New — {count} {count === 1 ? 'item' : 'items'}
			</span>
			<span aria-hidden="true" className="h-px flex-1 bg-brand/40" />
			<button
				type="button"
				onClick={onMarkRead}
				className="text-[10.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
			>
				<span aria-hidden="true">✓ </span>
				Mark all read
			</button>
		</div>
	)
}
