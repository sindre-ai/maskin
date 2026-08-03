import { type ReactNode, createContext, useCallback, useContext, useState } from 'react'

interface PageHeaderState {
	actions?: ReactNode
	stickyIdentity?: ReactNode
}

interface PageHeaderContextValue extends PageHeaderState {
	setActions: (actions: ReactNode) => void
	setStickyIdentity: (stickyIdentity: ReactNode) => void
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
	setActions: () => {},
	setStickyIdentity: () => {},
})

export function PageHeaderProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<PageHeaderState>({})

	const setActions = useCallback((actions: ReactNode) => {
		setState((prev) => ({ ...prev, actions }))
	}, [])

	const setStickyIdentity = useCallback((stickyIdentity: ReactNode) => {
		setState((prev) => ({ ...prev, stickyIdentity }))
	}, [])

	return (
		<PageHeaderContext.Provider value={{ ...state, setActions, setStickyIdentity }}>
			{children}
		</PageHeaderContext.Provider>
	)
}

export function usePageHeader() {
	return useContext(PageHeaderContext)
}
