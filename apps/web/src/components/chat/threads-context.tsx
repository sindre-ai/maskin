import { createContext, useContext } from 'react'

interface ThreadsPaneContextValue {
	/** Opens the Threads pane on one handed-off session. */
	openThread: (sessionId: string) => void
}

/**
 * Lets a handoff card inside a message bubble open the chat route's Threads
 * pane without drilling a callback through ThreadMessages → MessageBubble.
 * Null outside the route (tests, previews) — callers fall back to the strip.
 */
export const ThreadsPaneContext = createContext<ThreadsPaneContextValue | null>(null)

export function useThreadsPane() {
	return useContext(ThreadsPaneContext)
}
