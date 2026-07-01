import type * as PopoverPrimitive from '@radix-ui/react-popover'
import * as React from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'

// Switches Popover to a bottom Sheet at <768px. Pick this for form-control
// popovers — date pickers, multi-selects, anything where the user is making a
// selection and a desktop popover would miss the thumb zone or get clipped.
// Hover/info popovers should keep using <Popover> directly.

const ResponsivePopoverModeContext = React.createContext<'popover' | 'sheet'>('popover')

function useMode() {
	return React.useContext(ResponsivePopoverModeContext)
}

function ResponsivePopover({ children, ...props }: React.ComponentProps<typeof Popover>) {
	const isMobile = useIsMobile()
	const mode = isMobile ? 'sheet' : 'popover'
	const Root = isMobile ? Sheet : Popover
	return (
		<ResponsivePopoverModeContext.Provider value={mode}>
			<Root {...props}>{children}</Root>
		</ResponsivePopoverModeContext.Provider>
	)
}

const ResponsivePopoverTrigger = React.forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>((props, ref) => {
	const Trigger = useMode() === 'sheet' ? SheetTrigger : PopoverTrigger
	return <Trigger ref={ref} {...props} />
})
ResponsivePopoverTrigger.displayName = 'ResponsivePopoverTrigger'

// Radix's Sheet (built on Dialog) requires a Title for screen readers. Popover
// does not. We render a visually-hidden default in sheet mode so consumers
// don't need to learn the difference; pass `accessibleTitle` to override.
type ResponsivePopoverContentProps = React.ComponentPropsWithoutRef<
	typeof PopoverPrimitive.Content
> & {
	accessibleTitle?: string
}

const ResponsivePopoverContent = React.forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Content>,
	ResponsivePopoverContentProps
>(({ className, children, accessibleTitle = 'Options', ...props }, ref) => {
	if (useMode() === 'sheet') {
		return (
			<SheetContent
				ref={ref}
				side="bottom"
				className={cn(
					'flex max-h-[85dvh] w-full max-w-none flex-col rounded-t-lg rounded-b-none p-[var(--space-4)]',
					className,
				)}
				{...props}
			>
				<SheetTitle className="sr-only">{accessibleTitle}</SheetTitle>
				{children}
			</SheetContent>
		)
	}
	return (
		<PopoverContent ref={ref} className={className} {...props}>
			{children}
		</PopoverContent>
	)
})
ResponsivePopoverContent.displayName = 'ResponsivePopoverContent'

export { ResponsivePopover, ResponsivePopoverTrigger, ResponsivePopoverContent }
