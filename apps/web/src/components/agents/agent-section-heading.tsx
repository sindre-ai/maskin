/**
 * The one section-heading recipe used by every block on agent detail — a 14px
 * semibold heading, an optional muted note/count, a hairline rule filling the
 * remaining width, and an optional right-flush action (mockup 2427 / 2469 /
 * 2480 / 2490 / 2501). Before this, Sessions and Instructions drew this row by
 * hand while Usage, Skills and Tools used a mono `eyebrow` inside a bordered
 * card header — two recipes on one screen.
 */
export function AgentSectionHeading({
	id,
	title,
	note,
	noteClassName,
	action,
}: {
	id?: string
	title: string
	note?: React.ReactNode
	/** Semantic token class for the note — used to turn it amber when paused. */
	noteClassName?: string
	action?: React.ReactNode
}) {
	return (
		<div className="flex items-center gap-2">
			<h2 id={id} className="shrink-0 text-sm font-semibold tracking-tight text-foreground">
				{title}
			</h2>
			{note && (
				<span className={noteClassName ?? 'min-w-0 truncate text-[11px] text-muted-foreground'}>
					{note}
				</span>
			)}
			<div className="mx-2 h-px flex-1 bg-border" aria-hidden />
			{action}
		</div>
	)
}
