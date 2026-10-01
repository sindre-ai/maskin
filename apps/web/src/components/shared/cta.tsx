import { cn } from '@/lib/cn'
import { type ButtonHTMLAttributes, forwardRef } from 'react'

type CTAVariant = 'dashed'

interface CTAProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: CTAVariant
}

/**
 * Shared call-to-action button. `variant="dashed"` is the pill-shaped
 * `border-dashed` affordance used to end a list section — currently the
 * relationships tab's `+ Link an object` / `+ Upload a file` row. Second
 * variant will land here rather than as another one-off className soup.
 */
export const CTA = forwardRef<HTMLButtonElement, CTAProps>(function CTA(
	{ variant = 'dashed', className, type = 'button', ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			type={type}
			className={cn(
				variant === 'dashed' &&
					'inline-flex h-8 w-full items-center justify-center rounded-full border border-dashed border-border-strong bg-transparent px-3.5 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-ring hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
				className,
			)}
			{...rest}
		/>
	)
})
