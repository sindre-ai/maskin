import { cn } from '@/lib/cn'

export type StatusPillTone = 'ok' | 'warn' | 'err' | 'new'

const TONE_CLASSES: Record<StatusPillTone, string> = {
	ok: 'bg-success/10 text-success',
	warn: 'bg-warning/10 text-warning',
	err: 'bg-error/10 text-error',
	new: 'bg-primary/10 text-primary',
}

/** Small uppercase pill for provider state (Connected, Partial, Attention, New).
 *  The text is the accessible name; the colour never carries meaning alone. */
export function StatusPill({
	tone,
	children,
	className,
}: {
	tone: StatusPillTone
	children: string
	className?: string
}) {
	return (
		<span
			className={cn(
				'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
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
