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
	/**
	 * Opens the sheet and stages context. Optional `message` is forwarded to the
	 * sheet's composer which auto-sends it on open (used by the Pulse input bar
	 * so the conversation continues in the sheet).
	 */
	openWithContext: (attachments: SindreAttachment[], message?: string) => void
	/** Attachments staged by the most recent `openWithContext` call. */
	pendingAttachments: SindreAttachment[]
	clearPendingAttachments: () => void
	/** Message staged by the most recent `openWithContext` call. */
	pendingMessage: string | null
	clearPendingMessage: () => void
	/**
	 * Per-workspace Sindre session id. Persisted in localStorage so that the
	 * transcript survives page refresh. `null` until the first message has
	 * created a session.
	 */
	sessionId: string | null
	setSessionId: (id: string | null) => void
	/**
	 * When true the panel docks as a traditional sidebar that pushes page
	 * content aside; when false it floats as an overlay sheet on top of
	 * content. Cross-workspace UI preference, persisted in localStorage.
	 */
	pinned: boolean
	setPinned: (value: boolean) => void
}

const SindreContext = createContext<SindreContextValue | null>(null)

const SESSION_ID_STORAGE_PREFIX = 'maskin-sindre-session-id:'
const PINNED_STORAGE_KEY = 'maskin-sindre-pinned'

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

function readStoredPinned(): boolean {
	try {
		return localStorage.getItem(PINNED_STORAGE_KEY) === 'true'
	} catch {
		return false
	}
}

function writeStoredPinned(value: boolean): void {
	try {
		localStorage.setItem(PINNED_STORAGE_KEY, value ? 'true' : 'false')
	} catch {}
}

interface SindreProviderProps {
	workspaceId: string
	children: ReactNode
}

export function SindreProvider({ workspaceId, children }: SindreProviderProps) {
	const [open, setOpenState] = useState(false)
	const [pendingAttachments, setPendingAttachments] = useState<SindreAttachment[]>([])
	const [pendingMessage, setPendingMessage] = useState<string | null>(null)
	const [sessionId, setSessionIdState] = useState<string | null>(() =>
		readStoredSessionId(workspaceId),
	)
	const [pinned, setPinnedState] = useState<boolean>(() => readStoredPinned())

	// Swap to the target workspace's stored session id when the workspace
	// changes. Reset transient UI state so attachments and open state don't
	// leak across workspaces.
	useEffect(() => {
		setSessionIdState(readStoredSessionId(workspaceId))
		setPendingAttachments([])
		setPendingMessage(null)
		setOpenState(false)
	}, [workspaceId])

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => (typeof value === 'function' ? value(prev) : value))
	}, [])

	const openWithContext = useCallback((attachments: SindreAttachment[], message?: string) => {
		setPendingAttachments(attachments)
		setPendingMessage(typeof message === 'string' && message.length > 0 ? message : null)
		setOpenState(true)
	}, [])

	const clearPendingAttachments = useCallback(() => {
		setPendingAttachments([])
	}, [])

	const clearPendingMessage = useCallback(() => {
		setPendingMessage(null)
	}, [])

	const setSessionId = useCallback(
		(id: string | null) => {
			setSessionIdState(id)
			writeStoredSessionId(workspaceId, id)
		},
		[workspaceId],
	)

	const setPinned = useCallback((value: boolean) => {
		setPinnedState(value)
		writeStoredPinned(value)
	}, [])

	const value = useMemo<SindreContextValue>(
		() => ({
			open,
			setOpen,
			openWithContext,
			pendingAttachments,
			clearPendingAttachments,
			pendingMessage,
			clearPendingMessage,
			sessionId,
			setSessionId,
			pinned,
			setPinned,
		}),
		[
			open,
			setOpen,
			openWithContext,
			pendingAttachments,
			clearPendingAttachments,
			pendingMessage,
			clearPendingMessage,
			sessionId,
			setSessionId,
			pinned,
			setPinned,
		],
	)

	return <SindreContext.Provider value={value}>{children}</SindreContext.Provider>
}

export function useSindre(): SindreContextValue {
	const ctx = useContext(SindreContext)
	if (!ctx) throw new Error('useSindre must be used within a SindreProvider')
	return ctx
}
