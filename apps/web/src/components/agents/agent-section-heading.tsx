import { cn } from '@/lib/cn'

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
	quiet = false,
	srOnly = false,
}: {
	id?: string
	title: string
	note?: React.ReactNode
	/** Semantic token class for the note — used to turn it amber when paused. */
	noteClassName?: string
	action?: React.ReactNode
	/** The smaller muted label (Driving, Works in) instead of the bold section title. */
	quiet?: boolean
	/** Keeps the heading for screen readers and hides the row (the Sessions tab opens on its chips). */
	srOnly?: boolean
}) {
	return (
		<div className={cn('flex items-center gap-2 px-1 leading-tight', srOnly && 'sr-only')}>
			<h2
				id={id}
				className={
					quiet
						? 'shrink-0 text-[13px] font-semibold text-muted-foreground'
						: 'shrink-0 text-[15px] font-bold text-foreground'
				}
			>
				{title}
			</h2>
			{note && (
				<span className={noteClassName ?? 'min-w-0 truncate text-[13px] text-muted-foreground'}>
					{note}
				</span>
			)}
			<div className="flex-1" aria-hidden />
			{action}
		</div>
	)
}
