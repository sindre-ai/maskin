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
	 * When true the panel docks as a traditional sidebar that pushes page
	 * content aside; when false it floats as an overlay sheet on top of
	 * content. Cross-workspace UI preference, persisted in localStorage.
	 */
	pinned: boolean
	setPinned: (value: boolean) => void
	/**
	 * User-adjustable panel width in pixels. Clamped to
	 * `[SINDRE_PANEL_MIN_WIDTH, SINDRE_PANEL_MAX_WIDTH]` on write, persisted
	 * cross-workspace in localStorage.
	 */
	panelWidth: number
	setPanelWidth: (value: number) => void
}

export const SINDRE_PANEL_MIN_WIDTH = 320
export const SINDRE_PANEL_MAX_WIDTH = 640
export const SINDRE_PANEL_DEFAULT_WIDTH = 448

const SindreContext = createContext<SindreContextValue | null>(null)

const PINNED_STORAGE_KEY = 'maskin-sindre-pinned'
const PANEL_WIDTH_STORAGE_KEY = 'maskin-sindre-panel-width'

function clampPanelWidth(value: number): number {
	if (!Number.isFinite(value)) return SINDRE_PANEL_DEFAULT_WIDTH
	return Math.min(SINDRE_PANEL_MAX_WIDTH, Math.max(SINDRE_PANEL_MIN_WIDTH, Math.round(value)))
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
		return Number.isFinite(parsed) ? clampPanelWidth(parsed) : SINDRE_PANEL_DEFAULT_WIDTH
	} catch {
		return SINDRE_PANEL_DEFAULT_WIDTH
	}
}

function writeStoredPanelWidth(value: number): void {
	try {
		localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(value))
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
	const [pinned, setPinnedState] = useState<boolean>(() => readStoredPinned())
	const [panelWidth, setPanelWidthState] = useState<number>(() => readStoredPanelWidth())
	const prevWorkspaceIdRef = useRef(workspaceId)

	// Reset transient UI state so attachments and open state don't leak across
	// workspaces. Session id is tab-local (owned by useSindreSession) and
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

	const setPinned = useCallback((value: boolean) => {
		setPinnedState(value)
		writeStoredPinned(value)
	}, [])

	const setPanelWidth = useCallback((value: number) => {
		const clamped = clampPanelWidth(value)
		setPanelWidthState(clamped)
		writeStoredPanelWidth(clamped)
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

	return <SindreContext.Provider value={value}>{children}</SindreContext.Provider>
}

export function useSindre(): SindreContextValue {
	const ctx = useContext(SindreContext)
	if (!ctx) throw new Error('useSindre must be used within a SindreProvider')
	return ctx
}
