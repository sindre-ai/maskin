import { cn } from '@/lib/cn'

export type StatusPillTone = 'ok' | 'warn' | 'err' | 'new'

const TONE_CLASSES: Record<StatusPillTone, string> = {
	ok: 'bg-success/10 text-success',
	warn: 'bg-warning/10 text-warning',
	err: 'bg-error/10 text-error',
	new: 'bg-primary/10 text-primary',
}

/** Small pill for provider state (Connected, Partial, Attention, New). `soft` is the
 *  v3 settings reading, sentence case at 12px ("Active", "Reconnect needed", "Online");
 *  the default stays the small uppercase tag the Drive card uses.
 *  The text is the accessible name; the colour never carries meaning alone. */
export function StatusPill({
	tone,
	children,
	className,
	soft = false,
}: {
	tone: StatusPillTone
	children: string
	className?: string
	soft?: boolean
}) {
	return (
		<span
			className={cn(
				'inline-flex shrink-0 items-center rounded-full py-0.5',
				soft
					? 'px-2.5 text-xs font-semibold'
					: 'px-2 text-[10px] font-semibold uppercase tracking-wide',
				TONE_CLASSES[tone],
				className,
			)}
			aria-label={children}
			data-tone={tone}
		>
			{children}
		</span>
	)
}
