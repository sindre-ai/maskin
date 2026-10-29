/** Longest folder path shown in full before the leading folders are dropped. */
export const PATH_MAX_CHARS = 60

/** The path a folder watch is listed under. The watch's stored path is its
 *  ancestors; the folder's own name closes it unless the path already does. */
export function folderDisplayPath(watch: { name: string; path: string | null }): string {
	if (!watch.path) return watch.name
	const path = watch.path.replace(/\/+$/, '')
	const last = path.split('/').filter(Boolean).pop()
	return last === watch.name ? path : `${path}/${watch.name}`
}

/** Shortens a long path by dropping leading folders, never by cutting a folder
 *  name: "…/Clients/Acme/Briefs". The last folder always stays whole, however
 *  long it is, so the result can exceed `maxChars` rather than split a name. */
export function truncatePathAtSeparator(path: string, maxChars = PATH_MAX_CHARS): string {
	if (path.length <= maxChars) return path
	const segments = path.split('/').filter(Boolean)
	const kept: string[] = []
	let length = '…/'.length
	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i] as string
		const next = length + segment.length + (kept.length > 0 ? 1 : 0)
		if (kept.length > 0 && next > maxChars) break
		kept.unshift(segment)
		length = next
	}
	return kept.length === segments.length ? path : `…/${kept.join('/')}`
}
