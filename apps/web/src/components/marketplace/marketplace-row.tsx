import { getActorInitials } from '@/components/shared/actor-avatar'
import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

// A catalogue entry drawn as a list row (v16): 32px initials tile, name over a
// one-line description, then state pills and one action on the right. The
// catalogue holds hundreds of entries, so rows scale where the old cards did
// not. Shared by the flow row and the item row so both read the same.
//
// `overlay` is the full-row link to the detail page. It is absolutely
// positioned; anything the row wants clickable (the action, chips) must be
// `relative` so it paints above the link.
export function MarketplaceRow({
	name,
	description,
	overlay,
	extra,
	status,
	action,
}: {
	name: string
	description?: string | null
	overlay: ReactNode
	/** Content under the description (composition chips). */
	extra?: ReactNode
	/** State pills, left of the action. */
	status?: ReactNode
	action: ReactNode
}) {
	const initials = getActorInitials(name)
	return (
		<article
			className={cn(
				'relative flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-lg border-t border-border px-2 py-3.5',
				'transition-colors hover:bg-muted',
			)}
		>
			{overlay}
			<span
				aria-hidden="true"
				className={cn(
					'grid size-8 shrink-0 place-items-center rounded-[9px] bg-muted font-bold text-foreground',
					initials.length === 3 ? 'text-[9px]' : 'text-[11px]',
				)}
			>
				{initials}
			</span>
			<div className="min-w-0 flex-1 basis-40">
				<h3 className="truncate text-[15px] font-semibold text-foreground">{name}</h3>
				{description ? (
					<p className="truncate text-[13px] text-muted-foreground">{description}</p>
				) : null}
				{extra ? <div className="mt-1.5">{extra}</div> : null}
			</div>
			<div className="ml-auto flex shrink-0 items-center gap-2">
				{status}
				{action}
			</div>
		</article>
	)
}

/** Soft pill for a row's state ("Added", "Forked"). Tint variant is the
 * "v1.5 available" pill. */
export function RowPill({
	tone = 'soft',
	children,
}: {
	tone?: 'soft' | 'tint'
	children: ReactNode
}) {
	return (
		<span
			className={cn(
				'inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold',
				tone === 'tint' ? 'bg-brand/10 text-brand' : 'bg-muted text-foreground',
			)}
		>
			{children}
		</span>
	)
}

/** Shared class for the row's one action button: outline pill, 64px wide,
 * 44px tall on touch widths. */
export const ROW_ACTION_CLASS =
	'relative h-7 min-w-16 rounded-full px-3 text-[12.5px] font-semibold max-lg:min-h-11'
