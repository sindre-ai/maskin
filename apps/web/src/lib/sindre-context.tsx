import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'

/**
 * Attachment types the Sindre chat can be seeded with when
 * `openWithContext` is called. Kept as a discriminated union so new
 * picker kinds (agent, object, notification, …) can be added without
 * breaking existing consumers.
 */
export type SindreAttachment =
	| { kind: 'object'; id: string; title?: string | null; type?: string }
	| { kind: 'agent'; id: string; name?: string | null }
	| { kind: 'notification'; id: string; title?: string | null }

export interface SindreContextValue {
	open: boolean
	setOpen: (value: boolean | ((prev: boolean) => boolean)) => void
	openWithContext: (attachments: SindreAttachment[]) => void
	/** Attachments staged by the most recent `openWithContext` call. */
	pendingAttachments: SindreAttachment[]
	clearPendingAttachments: () => void
	/**
	 * Per-workspace Sindre session id. Persisted in localStorage so that the
	 * transcript survives page refresh. `null` until the first message has
	 * created a session.
	 */
	sessionId: string | null
	setSessionId: (id: string | null) => void
}

const SindreContext = createContext<SindreContextValue | null>(null)

const SESSION_ID_STORAGE_PREFIX = 'maskin-sindre-session-id:'

function storageKey(workspaceId: string): string {
	return `${SESSION_ID_STORAGE_PREFIX}${workspaceId}`
}

function readStoredSessionId(workspaceId: string): string | null {
	try {
		return localStorage.getItem(storageKey(workspaceId))
	} catch {
		return null
	}
}

function writeStoredSessionId(workspaceId: string, id: string | null): void {
	try {
		if (id === null) {
			localStorage.removeItem(storageKey(workspaceId))
		} else {
			localStorage.setItem(storageKey(workspaceId), id)
		}
	} catch {}
}

interface SindreProviderProps {
	workspaceId: string
	children: ReactNode
}

export function SindreProvider({ workspaceId, children }: SindreProviderProps) {
	const [open, setOpenState] = useState(false)
	const [pendingAttachments, setPendingAttachments] = useState<SindreAttachment[]>([])
	const [sessionId, setSessionIdState] = useState<string | null>(() =>
		readStoredSessionId(workspaceId),
	)

	// Swap to the target workspace's stored session id when the workspace
	// changes. Reset transient UI state so attachments and open state don't
	// leak across workspaces.
	useEffect(() => {
		setSessionIdState(readStoredSessionId(workspaceId))
		setPendingAttachments([])
		setOpenState(false)
	}, [workspaceId])

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => (typeof value === 'function' ? value(prev) : value))
	}, [])

	const openWithContext = useCallback((attachments: SindreAttachment[]) => {
		setPendingAttachments(attachments)
		setOpenState(true)
	}, [])

	const clearPendingAttachments = useCallback(() => {
		setPendingAttachments([])
	}, [])

	const setSessionId = useCallback(
		(id: string | null) => {
			setSessionIdState(id)
			writeStoredSessionId(workspaceId, id)
		},
		[workspaceId],
	)

	const value = useMemo<SindreContextValue>(
		() => ({
			open,
			setOpen,
			openWithContext,
			pendingAttachments,
			clearPendingAttachments,
			sessionId,
			setSessionId,
		}),
		[
			open,
			setOpen,
			openWithContext,
			pendingAttachments,
			clearPendingAttachments,
			sessionId,
			setSessionId,
		],
	)

	return <SindreContext.Provider value={value}>{children}</SindreContext.Provider>
}

export function useSindre(): SindreContextValue {
	const ctx = useContext(SindreContext)
	if (!ctx) throw new Error('useSindre must be used within a SindreProvider')
	return ctx
}
