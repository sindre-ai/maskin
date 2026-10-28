import { cn } from '@/lib/cn'
import { defaultTypeColor, typeColors, typeIcons } from '@/lib/constants'
import { type CardFact, unavailableCopy } from '@/lib/linked-objects'
import { Building2, type LucideIcon, Tag, Trash2, User } from 'lucide-react'
import type { ReactNode } from 'react'

// The built-in types with an icon of their own; a custom type gets the neutral tag.
const TYPE_ICON: Record<string, LucideIcon> = { ...typeIcons, contact: User, company: Building2 }

/** The icon of an object type: the mockup's for the built-in ones, a tag for a custom type. */
export function typeIconOf(type: string): LucideIcon {
	return TYPE_ICON[type] ?? Tag
}

/** The tile colours of an object type: its own pair, else `bg-secondary`. */
export function typeTileClass(type: string): string {
	const colors = typeColors[type]
	return colors ? cn(colors.bg, colors.text) : 'bg-secondary text-secondary-foreground'
}

/** The text colour of a type's icon on a chip. */
export function typeIconColor(type: string): string {
	return (typeColors[type] ?? defaultTypeColor).text
}

/**
 * The face every linked card shares, whatever it points at: a 24px icon tile, an eyebrow, the
 * state as a badge, then the title, a summary, up to three fact rows and a footer. It draws what
 * it is given and reads nothing itself, so a new kind is a new caller. It is the inside of the
 * card (the link, the shell and the fold are the caller's).
 */
export function LinkedCardFace({
	icon,
	tile,
	eyebrow,
	state,
	trailing,
	title,
	summary,
	facts,
	footer,
	actions,
}: {
	icon: ReactNode
	/** Colours of the tile: a type's pair, or `bg-secondary` for a kind without one. */
	tile: string
	/** The kind in caps: the type's name, LOOP, TRIGGER. */
	eyebrow: string
	/** The state badge, on the right of the first row. */
	state: ReactNode
	/** After the state: the open arrow, with room left for the fold button. */
	trailing?: ReactNode
	title: string
	summary?: string
	facts?: CardFact[]
	footer: ReactNode
	/** At the right end of the footer: the preview's Copy link and Open. */
	actions?: ReactNode
}) {
	return (
		<>
			<span className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className={cn('grid size-6 shrink-0 place-items-center rounded-md', tile)}
				>
					{icon}
				</span>
				<span className="eyebrow min-w-0 truncate">{eyebrow}</span>
				<span className="ml-auto shrink-0">{state}</span>
				{trailing}
			</span>
			<span className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
				{title}
			</span>
			{summary ? (
				<span className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
					{summary}
				</span>
			) : null}
			{facts && facts.length > 0 ? (
				<span className="mt-2 flex flex-col gap-0.5">
					{facts.map((fact) => (
						<span key={fact.label} className="flex gap-2 text-[11.5px] leading-snug">
							<span className="w-24 shrink-0 truncate text-muted-foreground">{fact.label}</span>
							<span className="min-w-0 flex-1 truncate text-foreground">{fact.value}</span>
						</span>
					))}
				</span>
			) : null}
			<span className="mt-2.5 flex items-center gap-x-3 border-t border-border-subtle pt-2 text-[11px] text-muted-foreground">
				<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{footer}</span>
				{actions}
			</span>
		</>
	)
}

/**
 * The card of something that cannot be drawn (deleted, trash icon), in the dashed, italic, muted
 * look. `kind` is the noun ("object", "loop", "trigger").
 */
export function UnavailableCard({
	shell,
	marker,
	kind,
}: {
	shell: string
	marker: string | undefined
	kind: string
}) {
	return (
		<span
			data-linked-card={marker}
			className={cn(
				shell,
				'flex-row items-center gap-2 border-dashed border-border bg-surface-sunken p-3 text-[12.5px] italic text-muted-foreground',
			)}
		>
			<Trash2 size={14} aria-hidden className="shrink-0" />
			{unavailableCopy(kind).card}
		</span>
	)
}

/** The chip of something that cannot be drawn, at the size of the sentence. */
export function UnavailableChip({ kind }: { kind: string }) {
	return (
		<span className="rounded-md border border-dashed border-border px-[0.4em] italic text-muted-foreground">
			<Trash2 size="0.85em" aria-hidden className="mr-[0.4em] inline-block align-middle" />
			{unavailableCopy(kind).chip}
		</span>
	)
}
