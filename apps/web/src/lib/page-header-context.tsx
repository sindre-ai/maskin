import { type ReactNode, createContext, useCallback, useContext, useState } from 'react'

interface PageHeaderState {
	actions?: ReactNode
	stickyIdentity?: ReactNode
	// CSS width value (e.g. '18rem') the current route wants the app shell
	// pushed left by — set when a page renders its own fixed right sidebar
	// (e.g. the object-detail properties sidebar) so the header's action
	// buttons stay clear of it, mirroring how the chat panel pushes content.
	contentPush?: string
}

interface PageHeaderContextValue extends PageHeaderState {
	setActions: (actions: ReactNode) => void
	setStickyIdentity: (stickyIdentity: ReactNode) => void
	setContentPush: (contentPush: string | undefined) => void
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
	setActions: () => {},
	setStickyIdentity: () => {},
	setContentPush: () => {},
})

export function PageHeaderProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<PageHeaderState>({})

	const setActions = useCallback((actions: ReactNode) => {
		setState((prev) => ({ ...prev, actions }))
	}, [])

	const setStickyIdentity = useCallback((stickyIdentity: ReactNode) => {
		setState((prev) => ({ ...prev, stickyIdentity }))
	}, [])

	const setContentPush = useCallback((contentPush: string | undefined) => {
		setState((prev) => ({ ...prev, contentPush }))
	}, [])

	return (
		<PageHeaderContext.Provider value={{ ...state, setActions, setStickyIdentity, setContentPush }}>
			{children}
		</PageHeaderContext.Provider>
	)
}

export function usePageHeader() {
	return useContext(PageHeaderContext)
}
