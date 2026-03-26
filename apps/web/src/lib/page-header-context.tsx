import { type ReactNode, createContext, useCallback, useContext, useState } from 'react'

interface PageHeaderState {
	actions?: ReactNode
	title?: string
}

interface PageHeaderContextValue extends PageHeaderState {
	setActions: (actions: ReactNode) => void
	setTitle: (title: string | undefined) => void
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
	setActions: () => {},
	setTitle: () => {},
})

export function PageHeaderProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<PageHeaderState>({})

	const setActions = useCallback((actions: ReactNode) => {
		setState((s) => ({ ...s, actions }))
	}, [])

	const setTitle = useCallback((title: string | undefined) => {
		setState((s) => ({ ...s, title }))
	}, [])

	return (
		<PageHeaderContext.Provider value={{ ...state, setActions, setTitle }}>
			{children}
		</PageHeaderContext.Provider>
	)
}

export function usePageHeader() {
	return useContext(PageHeaderContext)
}
