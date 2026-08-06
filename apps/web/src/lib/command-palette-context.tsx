import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'

/**
 * Lets other UI (e.g. the header "New" menu's "Find a past conversation" item)
 * open the command palette, instead of only its own ⌘K keydown listener.
 * See chat-context.tsx / new-conversation-context.tsx for the same pattern.
 */
export interface CommandPaletteContextValue {
	open: boolean
	setOpen: (value: boolean | ((prev: boolean) => boolean)) => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
	const [open, setOpenState] = useState(false)

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => (typeof value === 'function' ? value(prev) : value))
	}, [])

	const value = useMemo(() => ({ open, setOpen }), [open, setOpen])
	return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>
}

export function useCommandPalette(): CommandPaletteContextValue {
	const ctx = useContext(CommandPaletteContext)
	if (!ctx) throw new Error('useCommandPalette must be used within a CommandPaletteProvider')
	return ctx
}
