import { type ReactNode, createContext, useContext, useMemo, useState } from 'react'

/**
 * Lets CommandPalette (the single owner of the ⌘N keybinding, mirroring how it
 * already owns ⌘K/⌘J) and the For You dashboard share the New Conversation
 * composer's open state, instead of each binding their own competing ⌘N
 * listener. See chat-context.tsx for the same global/local sharing pattern.
 */
export interface NewConversationContextValue {
	open: boolean
	setOpen: (open: boolean) => void
}

const NewConversationContext = createContext<NewConversationContextValue | null>(null)

export function NewConversationProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false)
	const value = useMemo(() => ({ open, setOpen }), [open])
	return <NewConversationContext.Provider value={value}>{children}</NewConversationContext.Provider>
}

export function useNewConversationComposer(): NewConversationContextValue {
	const ctx = useContext(NewConversationContext)
	if (!ctx)
		throw new Error('useNewConversationComposer must be used within a NewConversationProvider')
	return ctx
}
