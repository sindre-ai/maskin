// Pure helpers for the tag input: which text a chip stands for, how a stored message splits
// into text and chips, and how the editable DOM turns back into text plus an id list.
//
// Storage (CTO, 30 Oct 2026): the text keeps the readable "@Name"; the ordered id list in
// metadata.mentions is what notifies. There is no id token in the text.

export interface TagActor {
	id: string
	name: string
	email?: string | null
}

export type TagSegment =
	| { kind: 'text'; text: string }
	| { kind: 'chip'; id: string; label: string }

/** The text a chip shows after the "@". Two actors that share a display name get an extra part,
 *  so the chip text in the sentence can only mean one id. */
export function tagLabel(actor: TagActor, pool: TagActor[]): string {
	const name = actor.name.trim()
	const clash = pool.some(
		(a) => a.id !== actor.id && a.name.trim().toLowerCase() === name.toLowerCase(),
	)
	if (!clash) return name
	return `${name} (${actor.email?.trim() || actor.id.slice(0, 4)})`
}

const WORD = /[\w-]/

/**
 * Splits stored text into plain text and chips. Each id claims every unclaimed "@label" in the
 * text that is not glued to a longer word. Ids with no such place in the text (messages sent
 * before tags lived in the text) come back in `unmatchedIds`.
 */
export function splitTextByTags(
	text: string,
	ids: string[],
	labelOf: (id: string) => string | null,
): { segments: TagSegment[]; unmatchedIds: string[] } {
	const claims: { start: number; end: number; id: string; label: string }[] = []
	const unmatchedIds: string[] = []
	// Longer labels first, so "@Sam Lee" is not eaten by the id whose label is "Sam".
	const order = ids
		.map((id, index) => ({ id, index, label: labelOf(id) }))
		.sort((a, b) => (b.label?.length ?? 0) - (a.label?.length ?? 0) || a.index - b.index)
	for (const { id, label } of order) {
		if (!label) {
			unmatchedIds.push(id)
			continue
		}
		const needle = `@${label}`
		let claimed = false
		let from = 0
		while (from <= text.length) {
			const at = text.indexOf(needle, from)
			if (at === -1) break
			const end = at + needle.length
			const before = at === 0 ? '' : (text[at - 1] ?? '')
			const after = text[end] ?? ''
			const free = !claims.some((c) => at < c.end && end > c.start)
			if (free && !WORD.test(before) && !WORD.test(after)) {
				claims.push({ start: at, end, id, label })
				claimed = true
				from = end
			} else {
				from = at + 1
			}
		}
		if (!claimed) unmatchedIds.push(id)
	}
	claims.sort((a, b) => a.start - b.start)
	const segments: TagSegment[] = []
	let cursor = 0
	for (const c of claims) {
		if (c.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, c.start) })
		segments.push({ kind: 'chip', id: c.id, label: c.label })
		cursor = c.end
	}
	if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
	// Keep the caller's id order for the leftovers.
	unmatchedIds.sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
	return { segments, unmatchedIds }
}

/**
 * The content an old message opens with in the edit card: tags that sat outside its text become
 * chips at the start, followed by one space each, so nothing is lost and the person can move them.
 */
export function editSegments(
	text: string,
	ids: string[],
	labelOf: (id: string) => string | null,
): TagSegment[] {
	const { segments, unmatchedIds } = splitTextByTags(text, ids, labelOf)
	const lead: TagSegment[] = []
	for (const id of unmatchedIds) {
		const label = labelOf(id)
		if (!label) continue
		lead.push({ kind: 'chip', id, label }, { kind: 'text', text: ' ' })
	}
	return [...lead, ...segments]
}

export interface TagValue {
	text: string
	ids: string[]
}

export const TAG_ID_ATTR = 'data-tag-id'
export const TAG_LABEL_ATTR = 'data-tag-label'

export function isTagChip(node: Node | null | undefined): node is HTMLElement {
	return !!node && node.nodeType === 1 && (node as HTMLElement).hasAttribute(TAG_ID_ATTR)
}

/** Reads the editable DOM: text nodes as they are, a line break as "\n", a chip as "@label" with
 *  its id added to the list (once, in the order the chips appear). */
export function readTagDom(root: Node): TagValue {
	let text = ''
	const ids: string[] = []
	const walk = (node: Node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === 3) {
				text += child.textContent ?? ''
			} else if (isTagChip(child)) {
				text += `@${child.getAttribute(TAG_LABEL_ATTR) ?? ''}`
				const id = child.getAttribute(TAG_ID_ATTR) ?? ''
				if (id && !ids.includes(id)) ids.push(id)
			} else if (child.nodeName === 'BR') {
				text += '\n'
			} else if (child.nodeType === 1) {
				// A block the browser made on Enter: it starts on its own line.
				const block = child.nodeName === 'DIV' || child.nodeName === 'P'
				if (block && text.length > 0 && !text.endsWith('\n')) text += '\n'
				walk(child)
			}
		}
	}
	walk(root)
	return { text, ids }
}
