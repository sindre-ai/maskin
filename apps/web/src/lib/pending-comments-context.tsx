import { trackCommentPostedFor } from '@/hooks/use-events'
import { useUploadFile } from '@/hooks/use-files'
import { trackObjectAttachedFile } from '@/lib/analytics'
import { type CreateCommentInput, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { newIdempotencyKey } from '@/lib/idempotency'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
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

export interface PendingFile {
	tempId: string
	name: string
	sizeBytes: number
	status: 'uploading' | 'uploaded' | 'failed'
	progress: number
	fileId?: string
	error?: string
}

export interface PendingComment {
	tempId: string
	workspaceId: string
	objectId: string
	content: string
	mentions: string[]
	parentEventId?: number
	files: PendingFile[]
	/**
	 * - 'draft'     — being composed; not yet visible in activity feed
	 * - 'submitted' — user clicked send but at least one file is still uploading
	 * - 'posting'   — all files uploaded, POST in flight
	 * - 'completed' — POST succeeded; will be dropped shortly
	 * - 'failed'    — upload or POST failed
	 */
	status: 'draft' | 'submitted' | 'posting' | 'completed' | 'failed'
	error?: string
	createdAt: number
	actorId: string | null
}

interface ContextValue {
	ensureDraft: (params: {
		draftId: string
		workspaceId: string
		objectId: string
		parentEventId?: number
	}) => void
	addAttachment: (draftId: string, file: File) => void
	removeAttachment: (draftId: string, fileTempId: string) => void
	submitDraft: (
		draftId: string,
		params: { content: string; mentions: string[] },
	) => 'queued' | 'no-attachments'
	discardDraft: (draftId: string) => void
	retryAttachment: (entryTempId: string, fileTempId: string) => void
	getEntry: (id: string) => PendingComment | undefined
	getSubmittedForObject: (objectId: string) => PendingComment[]
	subscribe: (listener: () => void) => () => void
}

const PendingCommentsContext = createContext<ContextValue | null>(null)

const COMPLETED_DROP_MS = 1200

interface ProviderProps {
	workspaceId: string
	children: ReactNode
}

export function PendingCommentsProvider({ workspaceId, children }: ProviderProps) {
	const queryClient = useQueryClient()
	const uploadFile = useUploadFile(workspaceId)

	// Map<entryId, PendingComment>. We use a ref + listener set rather than
	// useState so that high-frequency progress updates (XHR upload progress)
	// can be coalesced without React thrashing every consumer on every tick.
	const entriesRef = useRef<Map<string, PendingComment>>(new Map())
	const listenersRef = useRef<Set<() => void>>(new Set())
	const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
	const advancingRef = useRef<Set<string>>(new Set())

	// Reset state when switching workspaces — pending entries from a previous
	// workspace are no longer relevant and could leak file ids that don't
	// resolve in the new workspace. The reset must happen inline during render
	// (not in a useEffect) so consumers see the cleared state in the same
	// render. A useEffect cleanup runs *after* the render that picked up the
	// new workspaceId, by which point the activity feed has already re-read
	// the old entries.
	const lastWorkspaceIdRef = useRef(workspaceId)
	if (lastWorkspaceIdRef.current !== workspaceId) {
		for (const controller of abortControllersRef.current.values()) controller.abort()
		abortControllersRef.current.clear()
		advancingRef.current.clear()
		entriesRef.current.clear()
		lastWorkspaceIdRef.current = workspaceId
	}

	const notify = useCallback(() => {
		for (const l of listenersRef.current) l()
	}, [])

	const mutate = useCallback(
		(id: string, patch: (prev: PendingComment) => PendingComment | undefined) => {
			const prev = entriesRef.current.get(id)
			if (!prev) return
			const next = patch(prev)
			if (!next) {
				entriesRef.current.delete(id)
			} else {
				entriesRef.current.set(id, next)
			}
			notify()
		},
		[notify],
	)

	const mutateFile = useCallback(
		(entryId: string, fileTempId: string, patch: (prev: PendingFile) => PendingFile) => {
			mutate(entryId, (entry) => {
				const idx = entry.files.findIndex((f) => f.tempId === fileTempId)
				if (idx === -1) return entry
				const files = entry.files.slice()
				files[idx] = patch(files[idx])
				return { ...entry, files }
			})
		},
		[mutate],
	)

	const startUpload = useCallback(
		async (entryId: string, fileTempId: string, file: File) => {
			const controller = new AbortController()
			abortControllersRef.current.set(`${entryId}:${fileTempId}`, controller)
			try {
				const { readFileAsBase64 } = await import('@/lib/file-utils')
				const content = await readFileAsBase64(file)
				const created = await uploadFile(
					{
						name: file.name,
						mime_type: file.type || 'application/octet-stream',
						content,
						encoding: 'base64',
					},
					{
						signal: controller.signal,
						onProgress: (progress) => {
							mutateFile(entryId, fileTempId, (prev) => ({ ...prev, progress }))
						},
					},
				)
				mutateFile(entryId, fileTempId, (prev) => ({
					...prev,
					status: 'uploaded',
					progress: 1,
					fileId: created.id,
				}))
			} catch (err) {
				const aborted = controller.signal.aborted
				if (aborted) return
				mutateFile(entryId, fileTempId, (prev) => ({
					...prev,
					status: 'failed',
					error: err instanceof Error ? err.message : 'Upload failed',
				}))
			} finally {
				abortControllersRef.current.delete(`${entryId}:${fileTempId}`)
			}
		},
		[uploadFile, mutateFile],
	)

	const ensureDraft = useCallback<ContextValue['ensureDraft']>(
		({ draftId, workspaceId: ws, objectId, parentEventId }) => {
			if (entriesRef.current.has(draftId)) return
			const actor = getStoredActor()
			entriesRef.current.set(draftId, {
				tempId: draftId,
				workspaceId: ws,
				objectId,
				content: '',
				mentions: [],
				parentEventId,
				files: [],
				status: 'draft',
				createdAt: Date.now(),
				actorId: actor?.id ?? null,
			})
			notify()
		},
		[notify],
	)

	const addAttachment = useCallback<ContextValue['addAttachment']>(
		(draftId, file) => {
			const entry = entriesRef.current.get(draftId)
			if (!entry) return
			const fileTempId = newIdempotencyKey()
			const newFile: PendingFile = {
				tempId: fileTempId,
				name: file.name,
				sizeBytes: file.size,
				status: 'uploading',
				progress: 0,
			}
			entriesRef.current.set(draftId, { ...entry, files: [...entry.files, newFile] })
			notify()
			void startUpload(draftId, fileTempId, file)
		},
		[notify, startUpload],
	)

	const removeAttachment = useCallback<ContextValue['removeAttachment']>(
		(draftId, fileTempId) => {
			const controller = abortControllersRef.current.get(`${draftId}:${fileTempId}`)
			controller?.abort()
			mutate(draftId, (entry) => ({
				...entry,
				files: entry.files.filter((f) => f.tempId !== fileTempId),
			}))
		},
		[mutate],
	)

	const submitDraft = useCallback<ContextValue['submitDraft']>(
		(draftId, { content, mentions }) => {
			const entry = entriesRef.current.get(draftId)
			if (!entry) return 'no-attachments'
			if (entry.files.length === 0) {
				entriesRef.current.delete(draftId)
				notify()
				return 'no-attachments'
			}
			entriesRef.current.set(draftId, { ...entry, content, mentions, status: 'submitted' })
			notify()
			return 'queued'
		},
		[notify],
	)

	const discardDraft = useCallback<ContextValue['discardDraft']>(
		(draftId) => {
			const entry = entriesRef.current.get(draftId)
			if (!entry || entry.status !== 'draft') return
			for (const file of entry.files) {
				abortControllersRef.current.get(`${draftId}:${file.tempId}`)?.abort()
			}
			entriesRef.current.delete(draftId)
			notify()
		},
		[notify],
	)

	const retryAttachment = useCallback<ContextValue['retryAttachment']>(
		(_entryTempId, _fileTempId) => {
			// The raw File handle isn't kept after submission, so a retry can only
			// happen while the entry is still a draft and the user re-picks the
			// file. v1 surfaces the error in the composer; no in-place retry yet.
		},
		[],
	)

	const getEntry = useCallback<ContextValue['getEntry']>((id) => entriesRef.current.get(id), [])

	const getSubmittedForObject = useCallback<ContextValue['getSubmittedForObject']>(
		(objectId) =>
			Array.from(entriesRef.current.values()).filter(
				(e) =>
					e.objectId === objectId &&
					(e.status === 'submitted' || e.status === 'posting' || e.status === 'failed'),
			),
		[],
	)

	const subscribe = useCallback<ContextValue['subscribe']>((listener) => {
		listenersRef.current.add(listener)
		return () => {
			listenersRef.current.delete(listener)
		}
	}, [])

	// Drive submitted entries forward: when all files are uploaded, POST the
	// comment; on success, mark completed and drop after a brief grace period
	// so SSE has time to deliver the real event.
	useEffect(() => {
		const tryAdvance = async () => {
			// Iterate over keys and re-read the live entry inside the loop. The
			// synchronous `mutate(... 'posting')` below calls `notify()`, which
			// re-enters this function recursively. Without re-reading, the loop
			// would still see the stale snapshot and try to post the same entry
			// twice. The `advancingRef` adds belt-and-braces for any future async
			// path that might process the same entry concurrently.
			for (const tempId of Array.from(entriesRef.current.keys())) {
				if (advancingRef.current.has(tempId)) continue
				const entry = entriesRef.current.get(tempId)
				if (!entry || entry.status !== 'submitted') continue
				if (entry.files.some((f) => f.status === 'uploading')) continue
				if (entry.files.some((f) => f.status === 'failed')) {
					mutate(tempId, (prev) => ({
						...prev,
						status: 'failed',
						error: 'One or more attachments failed to upload',
					}))
					continue
				}
				const attachmentIds = entry.files.map((f) => f.fileId).filter((id): id is string => !!id)
				advancingRef.current.add(tempId)
				mutate(tempId, (prev) => ({ ...prev, status: 'posting' }))
				try {
					const body: CreateCommentInput = {
						entity_id: entry.objectId,
						content: entry.content,
						mentions: entry.mentions.length > 0 ? entry.mentions : undefined,
						parent_event_id: entry.parentEventId,
						attachment_file_ids: attachmentIds,
					}
					// Use the entry tempId as the idempotency key so any retry of the
					// same logical comment (re-entrant tryAdvance, transient network
					// failure, etc.) hits the server-side cached response instead of
					// creating a duplicate event.
					await api.events.create(entry.workspaceId, body, tempId)
					queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(entry.objectId) })
					trackCommentPostedFor(queryClient, entry.objectId, body, tempId)
					for (const fileId of attachmentIds) {
						const parentType = queryClient.getQueryData<{ type?: string }>(
							queryKeys.objects.detail(entry.objectId),
						)?.type
						if (
							parentType === 'bet' ||
							parentType === 'task' ||
							parentType === 'insight' ||
							parentType === 'knowledge' ||
							parentType === 'meeting'
						) {
							trackObjectAttachedFile({
								entity_id: entry.objectId,
								entity_type: parentType,
								flow_id: tempId,
								file_id: fileId,
								parent_entity_type: parentType,
							})
						}
					}
					mutate(tempId, (prev) => ({ ...prev, status: 'completed' }))
					setTimeout(() => {
						mutate(tempId, () => undefined)
					}, COMPLETED_DROP_MS)
				} catch (err) {
					mutate(tempId, (prev) => ({
						...prev,
						status: 'failed',
						error: err instanceof Error ? err.message : 'Failed to post comment',
					}))
				} finally {
					advancingRef.current.delete(tempId)
				}
			}
		}

		const unsubscribe = subscribe(() => {
			void tryAdvance()
		})
		// Run once on mount in case there's state already
		void tryAdvance()
		return unsubscribe
	}, [subscribe, mutate, queryClient])

	const value = useMemo<ContextValue>(
		() => ({
			ensureDraft,
			addAttachment,
			removeAttachment,
			submitDraft,
			discardDraft,
			retryAttachment,
			getEntry,
			getSubmittedForObject,
			subscribe,
		}),
		[
			ensureDraft,
			addAttachment,
			removeAttachment,
			submitDraft,
			discardDraft,
			retryAttachment,
			getEntry,
			getSubmittedForObject,
			subscribe,
		],
	)

	// On Provider unmount, abort any in-flight uploads so they don't leak. The
	// workspace-change reset above already handles the in-session case.
	useEffect(() => {
		return () => {
			for (const controller of abortControllersRef.current.values()) controller.abort()
		}
	}, [])

	return <PendingCommentsContext.Provider value={value}>{children}</PendingCommentsContext.Provider>
}

/**
 * Stub used when the composer is rendered outside a PendingCommentsProvider
 * (e.g., isolated component tests). All actions are no-ops so the composer
 * still functions for the no-attachment path — attachments are simply
 * unsupported in that context.
 */
const NOOP_CONTEXT: ContextValue = {
	ensureDraft: () => {},
	addAttachment: () => {},
	removeAttachment: () => {},
	submitDraft: () => 'no-attachments',
	discardDraft: () => {},
	retryAttachment: () => {},
	getEntry: () => undefined,
	getSubmittedForObject: () => [],
	subscribe: () => () => {},
}

function usePendingComments(): ContextValue {
	return useContext(PendingCommentsContext) ?? NOOP_CONTEXT
}

/**
 * Re-renders whenever the queue changes. Use to read from the queue in
 * components that need to react to its state.
 */
function useQueueVersion(): number {
	const ctx = usePendingComments()
	const [version, setVersion] = useState(0)
	useEffect(() => ctx.subscribe(() => setVersion((v) => v + 1)), [ctx])
	return version
}

/**
 * Composer-side hook: ensures a draft exists for the given draftId and exposes
 * attachment + submit actions. The draft is created lazily on first attach.
 */
export function useDraft(params: {
	draftId: string
	workspaceId: string
	objectId: string
	parentEventId?: number
}) {
	const ctx = usePendingComments()
	useQueueVersion()
	const entry = ctx.getEntry(params.draftId)

	const attach = useCallback(
		(file: File) => {
			ctx.ensureDraft(params)
			ctx.addAttachment(params.draftId, file)
		},
		[ctx, params],
	)

	const remove = useCallback(
		(fileTempId: string) => ctx.removeAttachment(params.draftId, fileTempId),
		[ctx, params.draftId],
	)

	const submit = useCallback(
		(submission: { content: string; mentions: string[] }) =>
			ctx.submitDraft(params.draftId, submission),
		[ctx, params.draftId],
	)

	const discard = useCallback(() => ctx.discardDraft(params.draftId), [ctx, params.draftId])

	return {
		files: entry?.files ?? [],
		attach,
		remove,
		submit,
		discard,
	}
}

/**
 * Activity-feed-side hook: returns submitted/posting/failed entries for an
 * object so the feed can render them as optimistic comments.
 */
export function usePendingCommentsForObject(objectId: string): PendingComment[] {
	const ctx = usePendingComments()
	useQueueVersion()
	return ctx.getSubmittedForObject(objectId)
}
