import { SidebarContext } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import * as React from 'react'

// 288px = 18rem expanded; 44px = 2.75rem collapsed rail. Design constants.
const SIDEBAR_WIDTH = '18rem'
const SIDEBAR_WIDTH_ICON = '2.75rem'

/**
 * Fork of shadcn's `SidebarProvider` for the object-detail right sidebar.
 * Mirrors `ChatSidebarProvider` — the two differences from the upstream
 * primitive are the ones the app-wide left `AppSidebar` establishes precedent
 * for:
 *   1. Binds the ⌘/Ctrl+I chord (not ⌘B — the left nav owns that; nesting two
 *      upstream providers would double-toggle).
 *   2. Fixed-positioned outer wrapper so the sidebar renders on top of its
 *      slot instead of trying to reserve horizontal space in the parent flex
 *      layout (the parent is the app-wide `SidebarProvider` for the left nav,
 *      whose `SidebarInset` is a flex-column, not flex-row).
 * Content-push (so the sidebar doesn't overlay the object body) is applied by
 * the consumer via a matching right margin on the doc wrapper.
 */
export const PropertiesSidebarProvider = React.forwardRef<
	HTMLDivElement,
	React.ComponentProps<'div'> & {
		open: boolean
		onOpenChange: (open: boolean) => void
		openMobile: boolean
		onOpenMobileChange: (open: boolean) => void
	}
>(
	(
		{ open, onOpenChange, openMobile, onOpenMobileChange, className, style, children, ...props },
		ref,
	) => {
		const isMobile = useIsMobile()

		const setOpen = React.useCallback(
			(value: boolean | ((value: boolean) => boolean)) => {
				const openState = typeof value === 'function' ? value(open) : value
				onOpenChange(openState)
			},
			[onOpenChange, open],
		)

		const setOpenMobile = React.useCallback(
			(value: boolean | ((value: boolean) => boolean)) => {
				const openState = typeof value === 'function' ? value(openMobile) : value
				onOpenMobileChange(openState)
			},
			[onOpenMobileChange, openMobile],
		)

		// Mobile toggles the transient Sheet; tablet/desktop toggle the
		// persisted `open` bit.
		const toggleSidebar = React.useCallback(() => {
			return isMobile ? setOpenMobile((prev) => !prev) : setOpen((prev) => !prev)
		}, [isMobile, setOpen, setOpenMobile])

		React.useEffect(() => {
			const handleKeyDown = (event: KeyboardEvent) => {
				if (event.key !== 'i' || (!event.metaKey && !event.ctrlKey)) return
				// Skip inside inputs — ⌘I is also italic in text editors.
				const target = event.target as HTMLElement | null
				if (target) {
					const tag = target.tagName
					if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
				}
				event.preventDefault()
				toggleSidebar()
			}
			window.addEventListener('keydown', handleKeyDown)
			return () => window.removeEventListener('keydown', handleKeyDown)
		}, [toggleSidebar])

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
			[state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar],
		)

		return (
			<SidebarContext.Provider value={contextValue}>
				<TooltipProvider delayDuration={0}>
					<div
						style={
							{
								'--sidebar-width': SIDEBAR_WIDTH,
								'--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
								...style,
							} as React.CSSProperties
						}
						className={cn(
							'pointer-events-none fixed inset-0 z-30',
							// Force the sidebar's outer wrapper visible — the primitive
							// hides `data-side=right` behind `hidden md:block`; the
							// mobile Sheet branch handles its own visibility.
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
	},
)
PropertiesSidebarProvider.displayName = 'PropertiesSidebarProvider'
