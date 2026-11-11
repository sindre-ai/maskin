/**
 * A loop's custom views, in tab order. They live on the loop as
 * `metadata.views = [{ name, file_id }]`. Loops pinned before tabs existed carry
 * a single `metadata.view_file_id`; it reads as one view named "Custom view"
 * until `views` is written (then `views` wins, even when empty).
 */

import { z } from 'zod'

export interface LoopView {
	name: string
	fileId: string
}

export const LEGACY_LOOP_VIEW_NAME = 'Custom view'
export const MAX_LOOP_VIEW_NAME_LENGTH = 30

/** One row of `metadata.views`, as the write path validates it. */
export const loopViewRowSchema = z.object({
	name: z.string().trim().min(1).max(MAX_LOOP_VIEW_NAME_LENGTH),
	file_id: z.string().uuid(),
})

export function readLoopViews(metadata: Record<string, unknown> | null | undefined): LoopView[] {
	const views = metadata?.views
	if (Array.isArray(views)) {
		return views.flatMap((v): LoopView[] => {
			const view = v as { name?: unknown; file_id?: unknown } | null
			return typeof view?.name === 'string' && typeof view.file_id === 'string'
				? [{ name: view.name, fileId: view.file_id }]
				: []
		})
	}
	const legacy = metadata?.view_file_id
	return typeof legacy === 'string' ? [{ name: LEGACY_LOOP_VIEW_NAME, fileId: legacy }] : []
}

/** Returns the trimmed name, or throws when it is empty or too long. */
export function normalizeLoopViewName(name: string): string {
	const trimmed = name.trim()
	if (trimmed.length === 0 || trimmed.length > MAX_LOOP_VIEW_NAME_LENGTH) {
		throw new Error(`View name must be 1 to ${MAX_LOOP_VIEW_NAME_LENGTH} characters.`)
	}
	return trimmed
}

/**
 * The views list after pinning `fileId` under `name` (replace in place, or append
 * a new tab), or removing the tab when `fileId` is null. Names match ignoring case.
 */
export function applyLoopView(views: LoopView[], name: string, fileId: string | null): LoopView[] {
	const same = (v: LoopView) => v.name.toLowerCase() === name.toLowerCase()
	if (fileId === null) return views.filter((v) => !same(v))
	return views.some(same)
		? views.map((v) => (same(v) ? { name: v.name, fileId } : v))
		: [...views, { name, fileId }]
}

export function toLoopViewsMetadata(views: LoopView[]): { name: string; file_id: string }[] {
	return views.map((v) => ({ name: v.name, file_id: v.fileId }))
}
