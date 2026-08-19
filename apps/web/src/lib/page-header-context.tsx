import { type ReactNode, createContext, useCallback, useContext, useState } from 'react'

/**
 * A detail screen's own breadcrumb (mockup 1033–1035, Object detail). When a
 * page publishes one the shared nav collapses to the mockup's compact detail
 * bar — `Parent › Name` at 12px with the page's actions right-aligned, and no
 * search, New button or back arrow.
 */
export interface PageHeaderCrumb {
	parentLabel: string
	parentTo: string
	parentParams?: Record<string, string>
	label: string
}

interface PageHeaderState {
	// The screen's own title and muted trailing count for the shared top nav's
	// per-screen <h1> (mockup lines 159–201). A page that sets neither falls
	// back to the route's label, so no screen is ever untitled.
	title?: string
	subtitle?: string
	actions?: ReactNode
	// Controls that belong beside the <h1>, inside the left cluster, rather
	// than out in the right-hand cluster with search and New — the Objects
	// screen's type tabs (mockup 146–153, `margin-left:14px` on the h1's
	// sibling, before the `margin-left:auto` spacer).
	titleTabs?: ReactNode
	stickyIdentity?: ReactNode
	crumb?: PageHeaderCrumb
	// CSS width value (e.g. '18rem') the current route wants the app shell
	// pushed left by — set when a page renders its own fixed right sidebar
	// (e.g. the object-detail properties sidebar) so the header's action
	// buttons stay clear of it, mirroring how the chat panel pushes content.
	contentPush?: string
	// True when the current route owns its own internal scroll region (e.g. the
	// For You card queue's thread) and wants the shared page scroll container
	// to stop scrolling itself, so only that inner region scrolls.
	scrollLocked?: boolean
}

interface PageHeaderContextValue extends PageHeaderState {
	setTitle: (title: string | undefined) => void
	setSubtitle: (subtitle: string | undefined) => void
	setActions: (actions: ReactNode) => void
	setTitleTabs: (titleTabs: ReactNode) => void
	setStickyIdentity: (stickyIdentity: ReactNode) => void
	setCrumb: (crumb: PageHeaderCrumb | undefined) => void
	setContentPush: (contentPush: string | undefined) => void
	setScrollLocked: (scrollLocked: boolean) => void
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
	setTitle: () => {},
	setSubtitle: () => {},
	setActions: () => {},
	setTitleTabs: () => {},
	setStickyIdentity: () => {},
	setCrumb: () => {},
	setContentPush: () => {},
	setScrollLocked: () => {},
})

export function PageHeaderProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<PageHeaderState>({})

	const setTitle = useCallback((title: string | undefined) => {
		setState((prev) => ({ ...prev, title }))
	}, [])

	const setSubtitle = useCallback((subtitle: string | undefined) => {
		setState((prev) => ({ ...prev, subtitle }))
	}, [])

	const setActions = useCallback((actions: ReactNode) => {
		setState((prev) => ({ ...prev, actions }))
	}, [])

	const setTitleTabs = useCallback((titleTabs: ReactNode) => {
		setState((prev) => ({ ...prev, titleTabs }))
	}, [])

	const setStickyIdentity = useCallback((stickyIdentity: ReactNode) => {
		setState((prev) => ({ ...prev, stickyIdentity }))
	}, [])

	const setCrumb = useCallback((crumb: PageHeaderCrumb | undefined) => {
		setState((prev) => ({ ...prev, crumb }))
	}, [])

	const setContentPush = useCallback((contentPush: string | undefined) => {
		setState((prev) => ({ ...prev, contentPush }))
	}, [])

	const setScrollLocked = useCallback((scrollLocked: boolean) => {
		setState((prev) => ({ ...prev, scrollLocked }))
	}, [])

	return (
		<PageHeaderContext.Provider
			value={{
				...state,
				setTitle,
				setSubtitle,
				setActions,
				setTitleTabs,
				setStickyIdentity,
				setCrumb,
				setContentPush,
				setScrollLocked,
			}}
		>
			{children}
		</PageHeaderContext.Provider>
	)
}

export function usePageHeader() {
	return useContext(PageHeaderContext)
}
