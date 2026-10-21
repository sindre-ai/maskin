const OBJECT_LINK = /\/objects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

/**
 * The objects a message links to, in the order they first appear, without
 * repeats. Agents refer to an object by a link to its page, so a link is the
 * signal that the reader would want to see what is behind it.
 */
export function extractLinkedObjectIds(content: string, max = 3): string[] {
	const ids: string[] = []
	for (const match of content.matchAll(OBJECT_LINK)) {
		const id = match[1].toLowerCase()
		if (!ids.includes(id)) ids.push(id)
		if (ids.length >= max) break
	}
	return ids
}

const FILE_LINK = /\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

/**
 * The files a message links to (an HTML page, a document, a picture), in the order they first
 * appear, without repeats. Same signal as {@link extractLinkedObjectIds}: a link to a file
 * means the reader would want to see what is behind it.
 */
export function extractLinkedFileIds(content: string, max = 3): string[] {
	const ids: string[] = []
	for (const match of content.matchAll(FILE_LINK)) {
		const id = match[1].toLowerCase()
		if (!ids.includes(id)) ids.push(id)
		if (ids.length >= max) break
	}
	return ids
}

export interface LinkedSegment {
	/** Markdown to render; the card(s) for `objectIds` go right after it. */
	text: string
	/** Objects first linked in this segment. Empty for the text after the last card. */
	objectIds: string[]
}

/**
 * Cuts a message after each paragraph that links an object for the first time, so the card can
 * sit where the link is read instead of in a pile under the whole message. Cuts fall only on
 * blank lines outside a fenced block, and only where a card follows, so a message without links
 * stays one piece. A link repeated further down gets no second card; the cap matches
 * {@link extractLinkedObjectIds}.
 */
export function splitAtLinkedObjects(content: string, max = 3): LinkedSegment[] {
	const blocks: string[] = []
	let current: string[] = []
	let fence: string | null = null
	for (const line of content.split('\n')) {
		const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
		if (marker) {
			if (!fence) fence = marker
			else if (marker.startsWith(fence)) fence = null
		}
		if (!fence && line.trim() === '') {
			if (current.length > 0) blocks.push(current.join('\n'))
			current = []
		} else {
			current.push(line)
		}
	}
	if (current.length > 0) blocks.push(current.join('\n'))

	const seen: string[] = []
	const segments: LinkedSegment[] = []
	let pending: string[] = []
	for (const block of blocks) {
		pending.push(block)
		const fresh = extractLinkedObjectIds(block, max)
			.filter((id) => !seen.includes(id))
			.slice(0, max - seen.length)
		if (fresh.length === 0) continue
		seen.push(...fresh)
		segments.push({ text: pending.join('\n\n'), objectIds: fresh })
		pending = []
	}
	if (pending.length > 0) segments.push({ text: pending.join('\n\n'), objectIds: [] })
	return segments
}
