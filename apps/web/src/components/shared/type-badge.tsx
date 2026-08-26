import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { defaultTypeColor, typeColors, typeIcons } from '@/lib/constants'

export function TypeBadge({
	type,
	className,
	variant = 'badge',
	size = 'sm',
}: {
	type: string
	className?: string
	variant?: 'badge' | 'mono' | 'tile' | 'dot'
	/** `tile` only: 30px in card headers, 38px in list rows and detail headers. */
	size?: 'sm' | 'lg'
}) {
	// The smallest form the type takes: a solid dot in the type's own colour,
	// for places that need the type present but not read — a citation chip
	// where the object's name is the content and the type is only a category
	// cue (mockup 440's `r.dot`). `bg-current` inherits the type's text token,
	// so the one colour map still drives it.
	if (variant === 'dot') {
		const colors = typeColors[type] ?? defaultTypeColor
		return (
			<span
				aria-hidden="true"
				className={cn('size-1.5 shrink-0 rounded-full bg-current', colors.text, className)}
			/>
		)
	}

	// The tile is the type's visual anchor — a tinted square with the type's
	// lucide glyph, used wherever an object is the subject of a row or card
	// rather than a mention in running text.
	if (variant === 'tile') {
		const colors = typeColors[type] ?? defaultTypeColor
		// Only the built-in types have a lucide glyph. Module and custom-extension
		// types reach this tile too (the command palette and the create picker both
		// render whatever type the row holds), so they fall back to the type's
		// initial — an empty tinted square would carry no information at all.
		const Icon = typeIcons[type]
		return (
			<span
				aria-hidden="true"
				title={type}
				className={cn(
					'grid shrink-0 place-items-center rounded-lg',
					size === 'lg' ? 'size-[38px]' : 'size-[30px]',
					colors.bg,
					colors.text,
					className,
				)}
			>
				{Icon ? (
					<Icon className={size === 'lg' ? 'size-[18px]' : 'size-[15px]'} />
				) : (
					<span
						className={cn(
							'font-semibold leading-none',
							size === 'lg' ? 'text-[15px]' : 'text-[12px]',
						)}
					>
						{type.charAt(0).toUpperCase()}
					</span>
				)}
			</span>
		)
	}

	// The mono chip is the app's compact uppercase type label (used by the
	// Objects list rows); the badge pill is the richer default.
	if (variant === 'mono') {
		return (
			<span
				className={cn(
					'font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground',
					className,
				)}
			>
				{type}
			</span>
		)
	}
	return (
		<Badge variant="ghost" className={cn('font-medium', className)}>
			{type}
		</Badge>
	)
}
