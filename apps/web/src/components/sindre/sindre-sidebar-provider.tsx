import { SidebarContext } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
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
		defaultOpen?: boolean
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}
>(
	(
		{
			defaultOpen = false,
			open: openProp,
			onOpenChange: setOpenProp,
			className,
			style,
			children,
			...props
		},
		ref,
	) => {
		const isMobile = useIsMobile()
		const [openMobile, setOpenMobile] = React.useState(false)

		const [_open, _setOpen] = React.useState(defaultOpen)
		const open = openProp ?? _open
		const setOpen = React.useCallback(
			(value: boolean | ((value: boolean) => boolean)) => {
				const openState = typeof value === 'function' ? value(open) : value
				if (setOpenProp) {
					setOpenProp(openState)
				} else {
					_setOpen(openState)
				}
			},
			[setOpenProp, open],
		)

		const toggleSidebar = React.useCallback(() => {
			return isMobile ? setOpenMobile((prev) => !prev) : setOpen((prev) => !prev)
		}, [isMobile, setOpen])

		const state = open ? 'expanded' : 'collapsed'

		const contextValue = React.useMemo(
			() => ({
				state: state as 'expanded' | 'collapsed',
				open,
				setOpen,
				isMobile,
				openMobile,
				setOpenMobile,
				toggleSidebar,
			}),
			[state, open, setOpen, isMobile, openMobile, toggleSidebar],
		)

		return (
			<SidebarContext.Provider value={contextValue}>
				<TooltipProvider delayDuration={0}>
					<div
						style={style}
						className={cn('pointer-events-none fixed inset-0 z-40', className)}
						ref={ref}
						{...props}
					>
						{children}
					</div>
				</TooltipProvider>
			</SidebarContext.Provider>
		)
	},
)
SindreSidebarProvider.displayName = 'SindreSidebarProvider'
