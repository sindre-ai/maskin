import { z } from 'zod'

/**
 * `metadata.kind` that marks a `needs_input` notification as a For You item.
 * Other needs_input notifications (agent questions mid-session) carry no kind
 * and never reach the feed.
 */
export const FOR_YOU_KIND = 'for_you'

/**
 * What the Chief of Staff writes into `notification.metadata` for an item it
 * has decided the human must see. Read back by `GET /api/for-you`, which orders
 * by `rank` and re-checks every item against live state before returning it.
 */
export const forYouMetadataSchema = z.object({
	kind: z.literal(FOR_YOU_KIND),
	rank: z.number().describe('Position in the list; 1 is the most important. Lower sorts first.'),
	headline: z
		.string()
		.min(1)
		.describe('One line saying what is needed from the human, not what happened.'),
	rationale: z.string().optional().describe('Why the agents could not settle this themselves.'),
	// Event ids come back from the API as strings (they are bigints), and an agent
	// copying one into metadata passes it on as text. Accept digits either way:
	// a strict number made the whole item vanish from the list without an error.
	source_comment_id: z
		.preprocess((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v), z.number().int())
		.optional()
		.describe(
			'Event id of the comment carrying the ask. The item drops once the human replies to or dismisses that thread.',
		),
	only_while_status: z
		.array(z.string().min(1))
		.min(1)
		.optional()
		.describe(
			'The statuses the item\'s object must still be in for the ask to make sense, e.g. ["proposed"] for "move this bet to active". The item drops the moment the object\'s status is anything else, so a card cannot outlive the state it was written about.',
		),
})

export type ForYouMetadata = z.infer<typeof forYouMetadataSchema>

/** Parses stored metadata, returning null for rows that are not valid For You items. */
export function parseForYouMetadata(raw: unknown): ForYouMetadata | null {
	const parsed = forYouMetadataSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

/** Cards `list_for_you` returns when the caller gives no limit. */
export const FOR_YOU_TOOL_DEFAULT_LIMIT = 10
export const FOR_YOU_TOOL_MAX_LIMIT = 50
const FOR_YOU_ASK_MAX_CHARS = 200

/** The fields of a `GET /api/for-you` item that the slim agent view reads. */
export interface ForYouItemLike {
	notification_id: string | null
	source: string
	rank: number
	headline: string
	rationale: string | null
	due_at?: string | null
	entity_id: string | null
	object?: { title?: string | null; type?: string | null; status?: string | null } | null
	latest_mention?: { content?: string | null } | null
}

export interface SlimForYouCard {
	rank: number
	source: string
	headline: string
	rationale: string | null
	notification_id: string | null
	object_id: string | null
	title: string | null
	type: string | null
	status: string | null
	due_at: string | null
	ask: string | null
}

/**
 * The agent view of the For You list: the same cards in the same order as the web, cut down to
 * what is needed to say what the person has to do. A card is one object plus draft bodies that
 * can run to 20,000 characters, so the route payload would not fit in a Live call's tool result.
 * A card with no object (the daily budget card) keeps its headline and leaves the object fields null.
 */
export function slimForYouItems(
	items: ForYouItemLike[],
	limit: number = FOR_YOU_TOOL_DEFAULT_LIMIT,
	offset = 0,
): { total: number; items: SlimForYouCard[] } {
	return {
		total: items.length,
		items: items.slice(offset, offset + limit).map((item) => {
			const ask = item.latest_mention?.content?.trim()
			return {
				rank: item.rank,
				source: item.source,
				headline: item.headline,
				rationale: item.rationale,
				notification_id: item.notification_id,
				object_id: item.entity_id,
				title: item.object?.title ?? null,
				type: item.object?.type ?? null,
				status: item.object?.status ?? null,
				due_at: item.due_at ?? null,
				ask: ask ? ask.slice(0, FOR_YOU_ASK_MAX_CHARS) : null,
			}
		}),
	}
}
