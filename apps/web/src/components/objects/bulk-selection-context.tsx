import { createContext, useContext } from 'react'

export interface BulkSelectionContextValue {
	selectedIds: string[]
	clearSelection: () => void
}

export const BulkSelectionContext = createContext<BulkSelectionContextValue | null>(null)

export function useBulkSelection(): BulkSelectionContextValue {
	const ctx = useContext(BulkSelectionContext)
	if (!ctx) {
		throw new Error('useBulkSelection must be used within BulkSelectionContext.Provider')
	}
	return ctx
}
