import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

/**
 * Attachment types the chat can be seeded with when
 * `openWithContext` is called. Kept as a discriminated union so new
 * picker kinds (agent, object, notification, …) can be added without
 * breaking existing consumers.
 */
export type ChatAttachment =
	| { kind: 'object'; id: string; title?: string | null; type?: string }
	| { kind: 'agent'; id: string; name?: string | null }
	| { kind: 'notification'; id: string; title?: string | null }

export interface ChatContextValue {
	open: boolean
	setOpen: (value: boolean | ((prev: boolean) => boolean)) => void
	/**
	 * Opens the sheet and stages context. Optional `message` is forwarded to the
	 * sheet's composer which auto-sends it on open (used by the Pulse input bar
	 * so the conversation continues in the sheet).
	 */
	openWithContext: (attachments: ChatAttachment[], message?: string) => void
	/** Attachments staged by the most recent `openWithContext` call. */
	pendingAttachments: ChatAttachment[]
	clearPendingAttachments: () => void
	/** Message staged by the most recent `openWithContext` call. */
	pendingMessage: string | null
	clearPendingMessage: () => void
	/**
	 * When true the panel docks as a traditional sidebar that pushes page
	 * content aside; when false it floats as an overlay sheet on top of
	 * content. Cross-workspace UI preference, persisted in localStorage.
	 */
	pinned: boolean
	setPinned: (value: boolean) => void
	/**
	 * User-adjustable panel width in pixels. Clamped to
	 * `[CHAT_PANEL_MIN_WIDTH, CHAT_PANEL_MAX_WIDTH]` on write, persisted
	 * cross-workspace in localStorage.
	 */
	panelWidth: number
	setPanelWidth: (value: number) => void
}

export const CHAT_PANEL_MIN_WIDTH = 320
export const CHAT_PANEL_MAX_WIDTH = 640
export const CHAT_PANEL_DEFAULT_WIDTH = 448

const ChatContext = createContext<ChatContextValue | null>(null)

const PINNED_STORAGE_KEY = 'maskin-chat-pinned'
const PANEL_WIDTH_STORAGE_KEY = 'maskin-chat-panel-width'

function clampPanelWidth(value: number): number {
	if (!Number.isFinite(value)) return CHAT_PANEL_DEFAULT_WIDTH
	return Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, Math.round(value)))
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

function readStoredPanelWidth(): number {
	try {
		const raw = localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)
		const parsed = raw === null ? Number.NaN : Number(raw)
		return Number.isFinite(parsed) ? clampPanelWidth(parsed) : CHAT_PANEL_DEFAULT_WIDTH
	} catch {
		return CHAT_PANEL_DEFAULT_WIDTH
	}
}

function writeStoredPanelWidth(value: number): void {
	try {
		localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(value))
	} catch {}
}

interface ChatProviderProps {
	workspaceId: string
	children: ReactNode
}

export function ChatProvider({ workspaceId, children }: ChatProviderProps) {
	const [open, setOpenState] = useState(false)
	const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
	const [pendingMessage, setPendingMessage] = useState<string | null>(null)
	const [pinned, setPinnedState] = useState<boolean>(() => readStoredPinned())
	const [panelWidth, setPanelWidthState] = useState<number>(() => readStoredPanelWidth())
	const prevWorkspaceIdRef = useRef(workspaceId)

	// Reset transient UI state so attachments and open state don't leak across
	// workspaces. Session id is tab-local (owned by useChatSession) and
	// resets itself on workspaceId change.
	useEffect(() => {
		if (prevWorkspaceIdRef.current === workspaceId) return
		prevWorkspaceIdRef.current = workspaceId
		setPendingAttachments([])
		setPendingMessage(null)
		setOpenState(false)
	}, [workspaceId])

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => (typeof value === 'function' ? value(prev) : value))
	}, [])

	const openWithContext = useCallback((attachments: ChatAttachment[], message?: string) => {
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

	const setPinned = useCallback((value: boolean) => {
		setPinnedState(value)
		writeStoredPinned(value)
	}, [])

	const setPanelWidth = useCallback((value: number) => {
		const clamped = clampPanelWidth(value)
		setPanelWidthState(clamped)
		writeStoredPanelWidth(clamped)
	}, [])

	const value = useMemo<ChatContextValue>(
		() => ({
			open,
			setOpen,
			openWithContext,
			pendingAttachments,
			clearPendingAttachments,
			pendingMessage,
			clearPendingMessage,
			pinned,
			setPinned,
			panelWidth,
			setPanelWidth,
		}),
		[
			open,
			setOpen,
			openWithContext,
			pendingAttachments,
			clearPendingAttachments,
			pendingMessage,
			clearPendingMessage,
			pinned,
			setPinned,
			panelWidth,
			setPanelWidth,
		],
	)

	return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): ChatContextValue {
	const ctx = useContext(ChatContext)
	if (!ctx) throw new Error('useChat must be used within a ChatProvider')
	return ctx
}
