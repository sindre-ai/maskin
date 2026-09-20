import { cn } from '@/lib/cn'
import { type VariantProps, cva } from 'class-variance-authority'
import { AlertTriangle, X } from 'lucide-react'
import type * as React from 'react'

/**
 * Persistent, single-line banner rendered above the main scroll area to
 * surface a workspace-scoped signal (a low credit balance, an outdated
 * dependency, a scheduled maintenance window). Shared design-system primitive
 * intended to unlock several bets that need the same shape — see
 * `bet/6d84-credit-reliability` (low-balance banner) for the first consumer.
 *
 * One primary CTA (rendered as a child, typically a `<Button size="sm">`),
 * optional dismiss button, no toast animation. Dark-theme parity comes from
 * the semantic `--warning` / `--warning-foreground` token pair used by the
 * existing `TrialExpiredBanner` — kept identical so the two banners stack
 * without a visual seam if both fire.
 */
const bannerVariants = cva(
	'relative z-20 flex items-center justify-between gap-4 border-b px-4 py-2.5',
	{
		variants: {
			variant: {
				warning: 'border-warning/30 bg-warning/10 text-warning',
			},
		},
		defaultVariants: {
			variant: 'warning',
		},
	},
)

export interface BannerProps
	extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>,
		VariantProps<typeof bannerVariants> {
	/**
	 * The banner's message. Rendered inline with the variant icon on the left.
	 * Keep it short — a warning banner is a single line at all viewports.
	 */
	message: React.ReactNode
	/**
	 * The primary CTA element. Typically a `<Button size="sm">`. Rendered on
	 * the right at all viewports so touch users can reach it without scrolling.
	 */
	action?: React.ReactNode
	/**
	 * When set, renders a dismiss (×) button after the action and calls this on
	 * click. The parent owns the dismiss state — the banner itself is stateless
	 * so the same primitive can be per-page-load dismissible (low-balance) or
	 * per-workspace-lifetime dismissible (future consumers).
	 */
	onDismiss?: () => void
	/**
	 * Accessible label for the dismiss button. Required when `onDismiss` is
	 * set so screen readers announce "Dismiss low balance warning" rather than
	 * a bare "Close".
	 */
	dismissLabel?: string
}

export function Banner({
	className,
	variant,
	message,
	action,
	onDismiss,
	dismissLabel,
	...props
}: BannerProps) {
	return (
		<div className={cn(bannerVariants({ variant }), className)} {...props}>
			<div className="flex min-w-0 items-center gap-2 text-sm">
				<AlertTriangle size={14} className="shrink-0" aria-hidden />
				<span className="truncate">{message}</span>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{action}
				{onDismiss && (
					<button
						type="button"
						onClick={onDismiss}
						aria-label={dismissLabel ?? 'Dismiss'}
						className="inline-flex h-7 w-7 items-center justify-center rounded-md text-warning/80 transition-colors hover:bg-warning/10 hover:text-warning focus:outline-none focus:ring-2 focus:ring-ring"
					>
						<X size={14} aria-hidden />
					</button>
				)}
			</div>
		</div>
	)
}

export { bannerVariants }
