import { MAX_TAGS_PER_FILE, MAX_TAG_LENGTH, fileTagSchema } from '@maskin/shared'

export { MAX_TAGS_PER_FILE, MAX_TAG_LENGTH }

/** A typed tag as the server will store it (trimmed, lowercase), or null when it would be refused. */
export function normalizeFileTag(raw: string): string | null {
	const parsed = fileTagSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

/** A to Z, the order both apps use for any list of tags a person picks from. */
export function sortTagsAlphabetically<T extends string | { tag: string }>(items: T[]): T[] {
	const key = (item: T) => (typeof item === 'string' ? item : item.tag)
	return [...items].sort((a, b) =>
		key(a).localeCompare(key(b), undefined, { sensitivity: 'base', numeric: true }),
	)
}
