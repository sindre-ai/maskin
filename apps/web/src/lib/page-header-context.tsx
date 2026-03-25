import { type ReactNode, createContext, useCallback, useContext, useState } from 'react'

interface PageHeaderState {
	actions?: ReactNode
}

interface PageHeaderContextValue extends PageHeaderState {
	setActions: (actions: ReactNode) => void
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
	setActions: () => {},
})

export function PageHeaderProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<PageHeaderState>({})

	const setActions = useCallback((actions: ReactNode) => {
		setState({ actions })
	}, [])

	return (
		<PageHeaderContext.Provider value={{ ...state, setActions }}>
			{children}
		</PageHeaderContext.Provider>
	)
}

export function usePageHeader() {
	return useContext(PageHeaderContext)
}
