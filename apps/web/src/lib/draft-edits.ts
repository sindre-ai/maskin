import { ApiError, type ChatCardRef, api } from '@/lib/api'
import type { ObjectPreview } from '@maskin/shared'

// A person's edit of a draft's text, held until they approve it. The one place both cards
// that edit a draft use, the For You card and the chat card: the box that holds the text
// (`components/shared/draft-text-editor`), and the step that saves it and approves the saved
// text (`approveDraftText`). Keyed by the draft object, so a message in a stack and the card's
// own bar both find what the person typed. Same module-scope shape as `foryou-impressions`.

/** What a card knows of a draft: the object, the text it showed, and the preview that text came from. */
export interface DraftRef {
	object_id?: string
	body?: string
	preview?: ObjectPreview | null
}

const edits = new Map<string, string>()
// What the object says now, for a draft that changed while the person was editing it.
const changed = new Map<string, string>()
const listeners = new Set<() => void>()

const emit = () => {
	for (const listener of listeners) listener()
}

export function subscribeDraftEdits(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export const getDraftEdit = (objectId: string) => edits.get(objectId)
export const getDraftChange = (objectId: string) => changed.get(objectId)

export function setDraftEdit(objectId: string, text: string) {
	edits.set(objectId, text)
	changed.delete(objectId)
	emit()
}

export function clearDraftEdit(objectId: string) {
	edits.delete(objectId)
	changed.delete(objectId)
	emit()
}

/** The draft was changed by someone else after the card showed it: nothing was sent. */
export class DraftChangedError extends Error {
	constructor() {
		super('The draft changed while you were editing it.')
		this.name = 'DraftChangedError'
	}
}

const POST_START = '--- POST ---'
const POST_END = '--- MEDIA ---'

/**
 * The object's text with `edited` in place of `shown`, the part the card displays. A text
 * that is all message is replaced whole. A LinkedIn post carries a header and a media section
 * around its message; only the lines between the two markers change, and the header and media
 * stay as they were. Null when the message cannot be told from the rest (no markers, or a
 * marker twice): nothing guesses a position in a body.
 */
export function spliceDraftText(content: string, shown: string, edited: string): string | null {
	if (shown.trim() === content.trim()) return edited
	const eol = content.includes('\r\n') ? '\r\n' : '\n'
	const lines = content.split(/\r?\n/)
	const starts = lines.flatMap((line, i) => (line.trim() === POST_START ? [i] : []))
	const from = starts[0]
	if (starts.length !== 1 || from === undefined) return null
	const rest = lines.slice(from + 1)
	const ends = rest.flatMap((line, i) => (line.trim() === POST_END ? [i] : []))
	if (ends.length > 1) return null
	const to = ends[0] ?? rest.length
	const block = rest.slice(0, to)
	if (block.join('\n').trim() !== shown.trim()) return null
	// Keep the blank lines the block sat in, so the header and media lines do not move.
	let lead = 0
	while (lead < block.length && !block[lead]?.trim()) lead++
	let trail = 0
	while (trail < block.length - lead && !block[block.length - 1 - trail]?.trim()) trail++
	return [
		...lines.slice(0, from + 1),
		...Array<string>(lead).fill(''),
		...edited.split(/\r?\n/),
		...Array<string>(trail).fill(''),
		...rest.slice(to),
	].join(eol)
}

/**
 * Saves the person's edit to the draft object and returns the preview of the saved text, so
 * the approval is bound to exactly what they read. Reads the object first: when it no longer
 * matches what the card showed, the new text is put on the card, the edit is dropped and
 * nothing is saved or sent. Throws on any other failure, which also sends nothing.
 */
export async function saveDraftEdit(
	draft: DraftRef,
	edited: string,
): Promise<ObjectPreview | null> {
	const objectId = draft.object_id
	if (!objectId) throw new Error('This draft has no object to save to.')
	if (!edited.trim()) throw new Error('The draft is empty.')

	const current = await api.objects.get(objectId)
	const content = current.content ?? ''
	const shown = current.preview?.body ?? content
	const unchanged = draft.preview
		? draft.preview.content_hash === current.preview?.content_hash
		: (draft.body ?? '').trim() === content.trim()
	if (!unchanged) {
		edits.delete(objectId)
		changed.set(objectId, shown)
		emit()
		throw new DraftChangedError()
	}

	if (edited.trim() === shown.trim()) {
		clearDraftEdit(objectId)
		return current.preview ?? null
	}
	const next = spliceDraftText(content, shown, edited)
	if (next === null) throw new Error('This draft cannot be edited here.')
	const saved = await api.objects.update(objectId, { content: next })
	const preview = saved.preview ?? (await api.objects.get(objectId)).preview ?? null
	clearDraftEdit(objectId)
	return preview
}

/**
 * The person's yes to a draft, bound to the text they read. A text they edited is saved
 * first and approved by the hash of the saved text, in the same step; a draft that changed
 * under them (found on the read before the save, or refused by the server as a stale hash)
 * saves and approves nothing, puts the new text on the card and rejects. A draft with no
 * preview has nothing to approve and resolves with null once saved. `chat` names the chat
 * card the approval came from, so the server tells the agent behind it.
 */
export async function approveDraftText(
	draft: DraftRef,
	chat?: ChatCardRef,
): Promise<{ approval_id: number; preview: ObjectPreview } | null> {
	const objectId = draft.object_id
	if (!objectId) return null
	const edited = getDraftEdit(objectId)
	const preview =
		edited !== undefined ? await saveDraftEdit(draft, edited) : (draft.preview ?? null)
	if (!preview) return null
	try {
		return await api.objects.approve(objectId, preview.content_hash, chat)
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 409) throw error
		// The draft moved between the save and the approval: show what it says now, send nothing.
		const current = await api.objects.get(objectId)
		edits.delete(objectId)
		changed.set(objectId, current.preview?.body ?? current.content ?? '')
		emit()
		throw new DraftChangedError()
	}
}
