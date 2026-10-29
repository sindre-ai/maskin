// One payload for a list tool, built once and sent on both channels.
//
// A tool result has `content[0].text` and `structuredContent`. A live voice call reads only the
// text (`voice-session-channel.ts`), so anything that sits on one channel only is invisible to
// it. `next_cursor` was exactly that: it lived in `structuredContent` while the text carried the
// bare rows, and an agent saw a page of 25 with no sign that more existed.
//
// `buildListPayload` fixes the shape, `listResult` puts it on both channels.

export interface ListPageInfo {
	/** The limit that applied to this page (what the caller asked for, capped). */
	limit: number
	/** Rows in this response. The response cap may lower it after the fact. */
	returned: number
	/** How many rows match the filters in all, or null when the tool cannot know. */
	total: number | null
	/** True when another page follows. */
	has_more: boolean
}

export interface BuildListPayloadInput {
	/** Name of the rows field, for example `integrations`. */
	key: string
	rows: readonly unknown[]
	limit: number
	nextCursor: string | null
	total: number | null
	/** Extra top-level fields, for example a `summary`. Must not collide with `key`. */
	extra?: Record<string, unknown>
	/** One-line notes for the agent. They travel inside the payload, never appended to the text. */
	notes?: readonly string[]
}

/**
 * `{ <key>: rows, ...extra, notes?, page: { limit, returned, total, has_more }, next_cursor? }`.
 * `total` is the real count or null; it is never the page size.
 */
export function buildListPayload(input: BuildListPayloadInput): Record<string, unknown> {
	const { key, rows, limit, nextCursor, total, extra, notes } = input
	const page: ListPageInfo = {
		limit,
		returned: rows.length,
		total,
		has_more: nextCursor !== null,
	}
	return {
		[key]: rows,
		...(extra ?? {}),
		...(notes && notes.length > 0 ? { notes } : {}),
		page,
		...(nextCursor ? { next_cursor: nextCursor } : {}),
	}
}

/**
 * The text channel for a payload: the same JSON `structuredContent` carries.
 * Keep one function for it so no list tool formats its own text.
 */
export function listText(payload: Record<string, unknown>): string {
	return JSON.stringify(payload)
}
