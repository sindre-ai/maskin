import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'
import { type ComponentPropsWithoutRef, type ReactNode, forwardRef } from 'react'

/**
 * The primary half of the New control (mockup 262–265). Uses the shared
 * `Button` variants so hover/focus/disabled parity comes for free; the seam
 * with the caret half is squared off with `rounded-r-none`.
 *
 * The rest-props spread onto the underlying `Button` so a `DropdownMenuTrigger
 * asChild` wrapper can push its own `onPointerDown`/`onClick` into the
 * element — Radix's `Slot` clones the child JSX and delivers wiring props to
 * whatever it wraps.
 */
export const SplitButtonPrimary = forwardRef<
	HTMLButtonElement,
	{
		label: string
		title?: string
		ariaLabel?: string
		icon?: ReactNode
		onClick?: () => void
		disabled?: boolean
		className?: string
	} & Omit<ComponentPropsWithoutRef<'button'>, 'onClick' | 'title' | 'aria-label' | 'className'>
>(function SplitButtonPrimary(
	{ label, title, ariaLabel, icon, onClick, disabled, className, ...rest },
	ref,
) {
	return (
		<Button
			ref={ref}
			size="sm"
			onClick={onClick}
			title={title}
			aria-label={ariaLabel ?? label}
			disabled={disabled}
			className={cn(
				'h-[30px] gap-1.5 rounded-lg rounded-r-none px-2.5 text-xs font-semibold',
				className,
			)}
			{...rest}
		>
			{icon}
			<span className="hidden sm:inline">{label}</span>
		</Button>
	)
})

/**
 * The caret half of the New control — a 24px chevron trigger squared into
 * the primary's right edge with a subtle vertical rule between them. Callers
 * wrap it with `DropdownMenuTrigger asChild` when they want the shared new
 * menu, so this stays framework-neutral and spreads the wiring props from
 * Radix's `Slot` straight onto the underlying button.
 */
export const SplitButtonChevron = forwardRef<
	HTMLButtonElement,
	{
		ariaLabel: string
		title?: string
		disabled?: boolean
		className?: string
	} & Omit<ComponentPropsWithoutRef<'button'>, 'title' | 'aria-label' | 'className'>
>(function SplitButtonChevron({ ariaLabel, title, disabled, className, ...rest }, ref) {
	return (
		<Button
			ref={ref}
			size="sm"
			aria-label={ariaLabel}
			title={title}
			disabled={disabled}
			className={cn(
				'h-[30px] w-6 rounded-lg rounded-l-none border-l border-l-muted-foreground px-0',
				className,
			)}
			{...rest}
		>
			<ChevronDown aria-hidden className="size-3 opacity-70" />
		</Button>
	)
})

/**
 * Two-half `+ New` control (mockup lines 262–265): a labelled primary
 * action on the left, a caret opening the shared new-menu on the right.
 * The `+ New` split-button referenced in `object-detail-header.tsx`'s
 * mockup pointer — the current shared nav uses this same primitive so the
 * detail page renders one control, not two.
 *
 * Wraps the two halves in a flex row that carries the shared height (30px)
 * and disabled treatment (60% opacity + pointer-events-none, per D4's
 * read-only rule). Half-specific ARIA and click wiring live on the
 * children so a caller can hand the caret to a Radix trigger without
 * losing the wrapping styles.
 */
export function SplitButton({
	children,
	disabled,
	className,
}: {
	children: ReactNode
	disabled?: boolean
	className?: string
}) {
	return (
		<div
			className={cn(
				'inline-flex h-[30px] shrink-0 items-stretch',
				disabled && 'pointer-events-none opacity-60',
				className,
			)}
		>
			{children}
		</div>
	)
}
