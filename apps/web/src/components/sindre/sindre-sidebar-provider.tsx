import { SidebarContext } from '@/components/ui/sidebar'
import { cn } from '@/lib/cn'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import * as React from 'react'

/**
 * Fork of shadcn's `SidebarProvider` scoped to the Sindre right-side panel.
 * Two intentional differences from the upstream primitive:
 *   1. No `Ctrl/Cmd+B` keyboard shortcut — the left `AppSidebar` owns that
 *      chord, and nesting two upstream providers would double-toggle.
 *   2. The outer wrapper is `fixed inset-0 pointer-events-none` so the
 *      provider's internal flex layout (and the `<Sidebar>`'s gap div) never
 *      reserves horizontal space in the main page layout. The inner
 *      `<Sidebar>` re-enables pointer events on itself so the panel stays
 *      interactive. Pin-to-push is handled by the route layout applying a
 *      right margin when `pinned && open` — this provider never pushes.
 */
export const SindreSidebarProvider = React.forwardRef<
	HTMLDivElement,
	React.ComponentProps<'div'> & {
		open: boolean
		onOpenChange: (open: boolean) => void
	}
>(({ open, onOpenChange, className, style, children, ...props }, ref) => {
	// We intentionally *don't* delegate to shadcn's mobile Sheet fallback —
	// on mobile the Sindre panel should look and behave exactly like on
	// desktop (right-fixed sidebar, full-height slide). Overriding isMobile
	// to `false` in the SidebarContext skips the Sheet branch inside the
	// primitive; we still read the real breakpoint elsewhere via the hook
	// directly (e.g. to hide the pin button, which is meaningless when
	// there's nothing to push aside).
	const setOpen = React.useCallback(
		(value: boolean | ((value: boolean) => boolean)) => {
			const openState = typeof value === 'function' ? value(open) : value
			onOpenChange(openState)
		},
		[onOpenChange, open],
	)

	// Report `isMobile: false` in the context so shadcn's Sidebar primitive
	// skips its mobile Sheet branch. `openMobile` is effectively unused but
	// kept in the shape the context expects.
	const toggleSidebar = React.useCallback(() => {
		return setOpen((prev) => !prev)
	}, [setOpen])

	const state = open ? 'expanded' : 'collapsed'

	const contextValue = React.useMemo(
		() => ({
			state: state as 'expanded' | 'collapsed',
			open,
			setOpen,
			isMobile: false,
			openMobile: false,
			setOpenMobile: () => {},
			toggleSidebar,
		}),
		[state, open, setOpen, toggleSidebar],
	)

	return (
		<SidebarContext.Provider value={contextValue}>
			<TooltipProvider delayDuration={0}>
				<div
					style={style}
					// Force-display the nested shadcn Sidebar wrapper regardless of
					// the `hidden md:block` it applies — we want the right-fixed
					// panel on every breakpoint, not just desktop.
					className={cn(
						'pointer-events-none fixed inset-0 z-40',
						'[&_[data-side=right]]:!block',
						className,
					)}
					ref={ref}
					{...props}
				>
					{children}
				</div>
			</TooltipProvider>
		</SidebarContext.Provider>
	)
})
SindreSidebarProvider.displayName = 'SindreSidebarProvider'
