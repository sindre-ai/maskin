/**
 * Hook that runs a single-field object mutation through `update_objects`
 * with optimistic local state and rollback-on-error semantics. The card
 * renders `optimisticValue ?? object.field` so the change appears instantly,
 * and the value clears when the server confirms.
 *
 * Auth and audit: this hook does not handle either directly. It dispatches
 * through `useCallTool`, which routes the call to the MCP host with the
 * end-user's bearer token; the server-side `update_objects` handler hits
 * `PATCH /api/objects/:id`, which writes the audit row and SSE-fans-out
 * the change. See `packages/mcp/ACTIONS.md` for the full contract.
 */

import { useCallback, useRef, useState } from 'react'
import { useCallTool } from '../mcp-app-provider'
import type { MutationOutcome, ObjectMutation } from './types'

interface UseObjectMutationOptions<T> {
	objectId: string
	/** Object field name on the `update_objects` payload — e.g. `status`, `owner`. */
	field: 'status' | 'owner' | 'title' | 'content'
	workspaceId?: string
	/** Optional callback fired after the server confirmed the change. */
	onSuccess?: (next: T) => void
}

interface ToolResultLike {
	result: {
		isError?: boolean
		content?: Array<{ type: string; text?: string }>
		[key: string]: unknown
	}
	toolName: string
}

/**
 * Inspect an `update_objects` response and return the per-update outcome for
 * this hook's objectId. The tool returns an array of `{ id, success, error }`.
 *
 * Returns a soft failure (`success: false`) for any unparseable or
 * unrecognised response shape rather than silently reporting success — the
 * UI layer would otherwise clear the optimistic value and fire `onSuccess`
 * for a write the server may never have performed.
 */
function extractObjectResult(tr: ToolResultLike | null, objectId: string): MutationOutcome {
	if (!tr || tr.toolName !== 'update_objects') {
		return { success: false, error: 'Unexpected tool response' }
	}
	if (tr.result.isError === true) return { success: false, error: 'Mutation failed' }
	const text = tr.result.content?.find((c) => c.type === 'text')?.text
	if (!text) return { success: false, error: 'Empty tool response' }
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { success: false, error: 'Malformed tool response' }
	}
	if (!Array.isArray(parsed)) return { success: false, error: 'Malformed tool response' }
	const entry = parsed.find(
		(p): p is { id?: string; success?: boolean; error?: string } =>
			typeof p === 'object' && p !== null && (p as { id?: string }).id === objectId,
	)
	if (!entry) return { success: false, error: 'No result for this object' }
	if (entry.success === true) return { success: true }
	return { success: false, error: entry.error ?? 'Mutation failed' }
}

export function useObjectMutation<T>(opts: UseObjectMutationOptions<T>): ObjectMutation<T> {
	const callTool = useCallTool()
	const [optimisticValue, setOptimisticValue] = useState<T | null>(null)
	const [isPending, setIsPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const inflightToken = useRef(0)

	const reset = useCallback(() => {
		setOptimisticValue(null)
		setIsPending(false)
		setError(null)
	}, [])

	const run = useCallback(
		async (next: T): Promise<MutationOutcome> => {
			const token = ++inflightToken.current
			setOptimisticValue(next)
			setIsPending(true)
			setError(null)
			try {
				const args: Record<string, unknown> = {
					updates: [{ id: opts.objectId, [opts.field]: next }],
				}
				if (opts.workspaceId) args.workspace_id = opts.workspaceId
				const result = await callTool('update_objects', args)
				if (token !== inflightToken.current) return { success: false, error: 'Superseded' }
				const outcome = extractObjectResult(
					{ result: result as ToolResultLike['result'], toolName: 'update_objects' },
					opts.objectId,
				)
				if (!outcome.success) {
					setOptimisticValue(null)
					setError(outcome.error ?? 'Mutation failed')
				} else {
					opts.onSuccess?.(next)
					setOptimisticValue(null)
				}
				return outcome
			} catch (err) {
				if (token !== inflightToken.current) return { success: false, error: 'Superseded' }
				const message = err instanceof Error ? err.message : String(err)
				setOptimisticValue(null)
				setError(message)
				return { success: false, error: message }
			} finally {
				if (token === inflightToken.current) setIsPending(false)
			}
		},
		[callTool, opts.objectId, opts.field, opts.workspaceId, opts.onSuccess],
	)

	return { optimisticValue, isPending, error, run, reset }
}
