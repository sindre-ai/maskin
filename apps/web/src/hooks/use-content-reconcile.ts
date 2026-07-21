import { ApiError, type ObjectResponse, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import {
	type ConflictDetectedPayload,
	type ConflictResolutionOutcome,
	type ConflictResolvedPayload,
	extractTheirsFrom409,
} from '@/lib/reconcile/types'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

export type ReconcileBannerStatus =
	| 'idle'
	| 'conflict'
	| 'reviewing'
	| 'confirming_take_theirs'
	| 'retrying'

export interface ReconcileConflict {
	// The user's dirty draft that lost the race.
	mine: string
	// The current server state (title omitted; only body markdown is in scope
	// per the task's Out-of-Scope).
	theirs: string
	// Fresh version from the 409 body — echo this back on keep-mine to break
	// the deadlock.
	freshVersion: number | null
	// Full server object from the 409 body — used to hydrate the query cache on
	// take-theirs without a second fetch.
	theirsObject: ObjectResponse
}

export interface UseContentReconcileOptions {
	object: ObjectResponse
	// T5's emit sites. Called from within the resolution flow; T5 wires the
	// PostHog captures at these callbacks without changing this hook.
	onConflictDetected?: (payload: ConflictDetectedPayload) => void
	onConflictResolved?: (payload: ConflictResolvedPayload) => void
}

export interface UseContentReconcileResult {
	status: ReconcileBannerStatus
	conflict: ReconcileConflict | null
	// Editor writes flow through here. When idle, delegates to the PATCH. On
	// 409, records the conflict and surfaces the banner instead of retrying.
	saveContent: (content: string) => void
	// Banner actions.
	openReview: () => void
	closeReview: () => void
	keepMine: () => Promise<void>
	requestTakeTheirs: () => void
	cancelTakeTheirs: () => void
	confirmTakeTheirs: () => void
}

export function useContentReconcile({
	object,
	onConflictDetected,
	onConflictResolved,
}: UseContentReconcileOptions): UseContentReconcileResult {
	const queryClient = useQueryClient()
	const [status, setStatus] = useState<ReconcileBannerStatus>('idle')
	const [conflict, setConflict] = useState<ReconcileConflict | null>(null)
	// Whether the user opened the diff overlay for the currently-active
	// conflict. A ref (not state) because it's a resolution-time input to
	// `keepMine` / `confirmTakeTheirs` — no rerender needed when it flips.
	// Reset on every new conflict so re-conflicts don't inherit the flag.
	const hasReviewedRef = useRef(false)

	const runPatch = useCallback(
		async (content: string, expectedVersion: number | null): Promise<void> => {
			try {
				const fresh =
					expectedVersion == null
						? await api.objects.update(object.id, { content })
						: await api.objects.update(object.id, { content }, { expectedVersion })
				queryClient.setQueryData(queryKeys.objects.detail(object.id), fresh)
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(object.workspaceId) })
				return
			} catch (err) {
				if (err instanceof ApiError && err.status === 409) {
					const theirs = extractTheirsFrom409(err.body)
					if (theirs) {
						const next: ReconcileConflict = {
							mine: content,
							theirs: theirs.content ?? '',
							freshVersion: typeof theirs.version === 'number' ? theirs.version : null,
							theirsObject: theirs,
						}
						hasReviewedRef.current = false
						setConflict(next)
						setStatus('conflict')
						onConflictDetected?.({
							objectId: object.id,
							objectType: object.type,
							staleVersion: expectedVersion,
							freshVersion: next.freshVersion,
							mineLength: next.mine.length,
							theirsLength: next.theirs.length,
						})
						return
					}
				}
				throw err
			}
		},
		[object.id, object.type, object.workspaceId, queryClient, onConflictDetected],
	)

	const saveContent = useCallback(
		(content: string) => {
			if (status !== 'idle') return
			void runPatch(content, object.version ?? null)
		},
		[status, object.version, runPatch],
	)

	const openReview = useCallback(() => {
		if (status === 'idle') return
		hasReviewedRef.current = true
		setStatus('reviewing')
	}, [status])

	const closeReview = useCallback(() => {
		if (status !== 'reviewing') return
		setStatus('conflict')
	}, [status])

	const keepMine = useCallback(async () => {
		if (!conflict) return
		const outcome: ConflictResolutionOutcome = hasReviewedRef.current
			? 'reviewed_then_kept_mine'
			: 'kept_mine'
		setStatus('retrying')
		try {
			await runPatch(conflict.mine, conflict.freshVersion)
			// runPatch either succeeded (cache is fresh) or re-conflicted (new
			// conflict state already set by runPatch's 409 branch, which also reset
			// hasReviewedRef). Only clear the resolved state when we actually
			// succeeded — detected via the fact that status hasn't been bumped
			// back to 'conflict' by runPatch.
			setStatus((prev) => {
				if (prev === 'retrying') {
					onConflictResolved?.({
						objectId: object.id,
						objectType: object.type,
						freshVersion: conflict.freshVersion,
						resolution: outcome,
					})
					setConflict(null)
					return 'idle'
				}
				return prev
			})
		} catch {
			// Non-409 failure — leave the banner up so the user can retry.
			setStatus('conflict')
		}
	}, [conflict, runPatch, object.id, object.type, onConflictResolved])

	const requestTakeTheirs = useCallback(() => {
		if (status === 'idle') return
		setStatus('confirming_take_theirs')
	}, [status])

	const cancelTakeTheirs = useCallback(() => {
		if (status !== 'confirming_take_theirs') return
		setStatus('conflict')
	}, [status])

	const confirmTakeTheirs = useCallback(() => {
		if (!conflict) return
		const outcome: ConflictResolutionOutcome = hasReviewedRef.current
			? 'reviewed_then_took_theirs'
			: 'took_theirs'
		// Server already has this state — no PATCH needed. Push it into the
		// detail cache so the editor re-renders with theirs and the version
		// echoes on the next write.
		queryClient.setQueryData(queryKeys.objects.detail(object.id), conflict.theirsObject)
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(object.workspaceId) })
		onConflictResolved?.({
			objectId: object.id,
			objectType: object.type,
			freshVersion: conflict.freshVersion,
			resolution: outcome,
		})
		setConflict(null)
		setStatus('idle')
	}, [conflict, queryClient, object.id, object.type, object.workspaceId, onConflictResolved])

	return {
		status,
		conflict,
		saveContent,
		openReview,
		closeReview,
		keepMine,
		requestTakeTheirs,
		cancelTakeTheirs,
		confirmTakeTheirs,
	}
}
