import { cn } from '@/lib/cn'
import { Mic } from 'lucide-react'

export type ChatTypingVariant = 'dots' | 'eq' | 'mic'
export type ChatTypingState = 'typing' | 'stopped'

interface ChatTypingMotionProps {
	variant?: ChatTypingVariant
	state?: ChatTypingState
	className?: string
}

const DOT_ITEMS = 3
const EQ_ITEMS = 5
const EQ_HEIGHTS = ['h-2', 'h-3.5', 'h-5', 'h-3', 'h-2'] as const

/**
 * Status/motion glyph for typing: three renderings (dots, eq equalizer, mic
 * pulse). `typing` animates with the built-in `animate-pulse` utility;
 * `stopped` is a static muted rendering. No colour or radius literals and no
 * animation beyond those two states.
 */
export function ChatTypingMotion({
	variant = 'eq',
	state = 'typing',
	className,
}: ChatTypingMotionProps) {
	const typing = state === 'typing'
	const base = cn(
		'inline-flex items-center gap-0.5 text-muted-foreground',
		typing && 'text-primary',
		className,
	)

	if (variant === 'mic') {
		return (
			<span className={cn(base, 'text-base leading-none')} role="img" aria-label="Typing">
				<Mic size={14} className={cn('rounded-full', typing && 'animate-pulse')} aria-hidden />
			</span>
		)
	}

	if (variant === 'dots') {
		return (
			<span className={base} role="img" aria-label="Typing">
				{Array.from({ length: DOT_ITEMS }, (_, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: static dot glyphs never reorder
						key={index}
						className={cn(
							'size-1.5 rounded-full bg-current',
							typing && 'animate-pulse',
							typing && index === 1 && '[animation-delay:150ms]',
							typing && index === 2 && '[animation-delay:300ms]',
						)}
					/>
				))}
			</span>
		)
	}

	return (
		<span className={cn(base, 'items-end')} role="img" aria-label="Typing">
			{EQ_HEIGHTS.slice(0, EQ_ITEMS).map((height, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: static eq bars never reorder
					key={index}
					className={cn(
						'w-0.5 rounded-sm bg-current',
						height,
						typing && 'animate-pulse',
						typing && `[animation-delay:${index * 120}ms]`,
					)}
				/>
			))}
		</span>
	)
}
