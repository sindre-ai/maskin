import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'

// Shared open/close state for the Today's Brief panel. Provider mounts in the
// workspace layout so the panel and its trigger (T2 header) share a single
// source of truth without prop-drilling. Same pattern as NewConversationContext.
export interface TodayBriefContextValue {
	open: boolean
	setOpen: (open: boolean) => void
	toggle: () => void
}

const TodayBriefContext = createContext<TodayBriefContextValue | null>(null)

export function TodayBriefProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false)
	const toggle = useCallback(() => setOpen((prev) => !prev), [])
	const value = useMemo(() => ({ open, setOpen, toggle }), [open, toggle])
	return <TodayBriefContext.Provider value={value}>{children}</TodayBriefContext.Provider>
}

export function useTodayBrief(): TodayBriefContextValue {
	const ctx = useContext(TodayBriefContext)
	if (!ctx) throw new Error('useTodayBrief must be used within a TodayBriefProvider')
	return ctx
}
