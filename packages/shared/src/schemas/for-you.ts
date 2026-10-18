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
	source_comment_id: z
		.number()
		.int()
		.optional()
		.describe(
			'Event id of the comment carrying the ask. The item drops once the human replies to or dismisses that thread.',
		),
})

export type ForYouMetadata = z.infer<typeof forYouMetadataSchema>

/** Parses stored metadata, returning null for rows that are not valid For You items. */
export function parseForYouMetadata(raw: unknown): ForYouMetadata | null {
	const parsed = forYouMetadataSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}
