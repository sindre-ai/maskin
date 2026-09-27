import type { PositionDoc } from '@maskin/shared'
import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'

// The Slice 3 draft-comments store.
//
// Separate from `PendingCommentsProvider` in **pending-comments-context.tsx** —
// that queue was purpose-built for object comments with file attachments
// (attachment lifecycle, XHR progress, retry). File-viewer drafts are a
// different shape: per-pin position, per-file page, threading via parentId,
// and one round id that spans every unsent draft on a file. Reusing the
// object-comment queue would have forced its `PendingComment` shape to grow
// several optional fields and its state machine to fork inside the "posting"
// stage — so we mount a separate provider that speaks the file-comment
// shape natively, right inside the file route.
//
// Scope: only client-side drafts before the first POST. Once a draft is
// posted (via **useCreateFileComment**), it's a server row and the review
// panel reads it via **useFileComments**. This provider owns:
//   - The per-file draft list (drafts that haven't been posted yet).
//   - The client-generated **roundId** that new drafts get stamped with at
//     draft time. On successful Send, the store resets the round; the next
//     draft grabs a fresh **roundId** so successive rounds don't merge.
//   - The "annotate mode" flag that gates pin placement on the stage. The
//     route's **Esc** binding calls **exitAnnotateMode** to leave it (spec
//     §Keyboard).

export interface FileCommentDraft {
	tempId: string
	fileId: string
	page: number | null
	positionDoc: PositionDoc
	selector: string | null
	parentId: string | null
	body: string
	roundId: string
	createdAt: number
}

interface ContextValue {
	drafts: FileCommentDraft[]
	roundId: string
	annotateMode: boolean
	setAnnotateMode: (next: boolean) => void
	exitAnnotateMode: () => void
	addDraft: (input: {
		fileId: string
		page: number | null
		positionDoc: PositionDoc
		selector?: string | null
		parentId?: string | null
		body?: string
	}) => FileCommentDraft
	updateDraftBody: (tempId: string, body: string) => void
	removeDraft: (tempId: string) => void
	// Called after a successful Send: drop drafts by their tempIds and mint a
	// fresh roundId so the next draft on the same file starts a new round.
	completeRound: (postedTempIds: string[]) => void
	// Escape hatch: some flows (route unmount, file switch) clear the whole
	// staging area without posting — we don't want a stale draft to reappear
	// as the "current round" the next time the panel opens.
	resetDrafts: () => void
}

const FileCommentsContext = createContext<ContextValue | null>(null)

function randomId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID()
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface ProviderProps {
	children: ReactNode
	// Optional injection point for tests; production always uses `randomId`.
	// Keeping it here (rather than the deeper draft helpers) means test code
	// doesn't have to reach into the module cache to control uuids.
	makeId?: () => string
}

export function FileCommentsProvider({ children, makeId = randomId }: ProviderProps) {
	const [drafts, setDrafts] = useState<FileCommentDraft[]>([])
	const [roundId, setRoundId] = useState<string>(() => makeId())
	const [annotateMode, setAnnotateMode] = useState<boolean>(false)

	const exitAnnotateMode = useCallback(() => setAnnotateMode(false), [])

	const addDraft = useCallback<ContextValue['addDraft']>(
		(input) => {
			const draft: FileCommentDraft = {
				tempId: makeId(),
				fileId: input.fileId,
				page: input.page,
				positionDoc: input.positionDoc,
				selector: input.selector ?? null,
				parentId: input.parentId ?? null,
				body: input.body ?? '',
				roundId,
				createdAt: Date.now(),
			}
			setDrafts((prev) => [...prev, draft])
			return draft
		},
		[makeId, roundId],
	)

	const updateDraftBody = useCallback((tempId: string, body: string) => {
		setDrafts((prev) => prev.map((d) => (d.tempId === tempId ? { ...d, body } : d)))
	}, [])

	const removeDraft = useCallback((tempId: string) => {
		setDrafts((prev) => prev.filter((d) => d.tempId !== tempId))
	}, [])

	const completeRound = useCallback(
		(postedTempIds: string[]) => {
			setDrafts((prev) => prev.filter((d) => !postedTempIds.includes(d.tempId)))
			setRoundId(makeId())
			setAnnotateMode(false)
		},
		[makeId],
	)

	const resetDrafts = useCallback(() => {
		setDrafts([])
		setRoundId(makeId())
		setAnnotateMode(false)
	}, [makeId])

	const value = useMemo(
		() => ({
			drafts,
			roundId,
			annotateMode,
			setAnnotateMode,
			exitAnnotateMode,
			addDraft,
			updateDraftBody,
			removeDraft,
			completeRound,
			resetDrafts,
		}),
		[
			drafts,
			roundId,
			annotateMode,
			exitAnnotateMode,
			addDraft,
			updateDraftBody,
			removeDraft,
			completeRound,
			resetDrafts,
		],
	)

	return <FileCommentsContext.Provider value={value}>{children}</FileCommentsContext.Provider>
}

export function useFileCommentsContext(): ContextValue {
	const ctx = useContext(FileCommentsContext)
	if (!ctx) {
		throw new Error('useFileCommentsContext must be used inside a FileCommentsProvider')
	}
	return ctx
}

// Optional selector for callers that don't want to throw when unmounted (e.g.
// non-viewer surfaces that share the review panel). Returns `null` when the
// provider isn't in the tree.
export function useOptionalFileCommentsContext(): ContextValue | null {
	return useContext(FileCommentsContext)
}

// Hook used by the route to reset drafts when the fileId changes — the
// user opening a *different* file shouldn't see the previous file's drafts.
export function useResetDraftsOnFileChange(fileId: string | null, resetDrafts: () => void): void {
	useEffect(() => {
		if (!fileId) return
		resetDrafts()
	}, [fileId, resetDrafts])
}
