import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'

/**
 * Lets other UI (e.g. the header "New" menu's "Find a past conversation" item)
 * open the command palette, instead of only its own ⌘K keydown listener.
 * See chat-context.tsx / new-conversation-context.tsx for the same pattern.
 */
export interface CommandPaletteContextValue {
	open: boolean
	setOpen: (value: boolean | ((prev: boolean) => boolean)) => void
	/**
	 * True when the Search v2 launcher is the one mounted. The workspace layout reads
	 * the `search-v2` flag once and passes it here, so the header can follow it
	 * without a flag read of its own.
	 */
	searchV2: boolean
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)

export function CommandPaletteProvider({
	children,
	searchV2 = false,
}: {
	children: ReactNode
	searchV2?: boolean
}) {
	const [open, setOpenState] = useState(false)

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => (typeof value === 'function' ? value(prev) : value))
	}, [])

	const value = useMemo(() => ({ open, setOpen, searchV2 }), [open, setOpen, searchV2])
	return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>
}

export function useCommandPalette(): CommandPaletteContextValue {
	const ctx = useContext(CommandPaletteContext)
	if (!ctx) throw new Error('useCommandPalette must be used within a CommandPaletteProvider')
	return ctx
}
