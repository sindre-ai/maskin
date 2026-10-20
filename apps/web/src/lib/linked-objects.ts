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
