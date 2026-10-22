import { createContext, useContext } from 'react'

/** What a card in the transcript can ask the drawer to show. */
export interface LinkedPanelTarget {
	kind: 'object' | 'file'
	id: string
}

export interface LinkedPanelContextValue {
	/** Opens the Overview drawer on its Linked tab with this item in view. */
	openLinked: (target: LinkedPanelTarget) => void
}

/**
 * Provided by the chat route, which owns the Overview drawer. Null outside a chat that has one,
 * so a card rendered anywhere else simply shows no "Show in panel" control.
 */
export const LinkedPanelContext = createContext<LinkedPanelContextValue | null>(null)

export function useLinkedPanel(): LinkedPanelContextValue | null {
	return useContext(LinkedPanelContext)
}
