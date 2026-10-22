import { z } from 'zod'

/**
 * The `preview` projection of an object: what a person needs to read, check and
 * approve something an agent wants to send, drawn the same way in chat, For You and
 * an MCP client.
 *
 * An object opts in with `metadata.kind` (for example `email`). Which kinds exist,
 * and which fields each one carries, is declared by the integration that delivers it
 * (`deliverables` in the provider's config.ts), never here. The projection is
 * computed on read from the object's current text and metadata, so it is never stale
 * and nothing is stored.
 */

export const previewRecipientSchema = z.object({
	role: z.enum(['to', 'cc']),
	/** Display name when one is known. A bare address has none. */
	name: z.string().nullable(),
	address: z.string().nullable(),
})

/** One labelled line of a preview that is not a recipient or the subject: "Posting as", "Channel". */
export const previewDetailSchema = z.object({
	label: z.string(),
	value: z.string(),
})

export const objectPreviewSchema = z.object({
	/** The declared kind, from `metadata.kind`: "email", "linkedin_message", … */
	kind: z.string(),
	/** Human label of the kind, for the small header above the text: "Email". */
	label: z.string(),
	/** The integration that delivers this kind, or null when none is connected to it. */
	provider: z.string().nullable(),
	recipients: z.array(previewRecipientSchema),
	subject: z.string().nullable(),
	/** Other facts about where it goes (the account a post is published as, a Slack channel). */
	details: z.array(previewDetailSchema),
	/**
	 * What the draft answers, as the person who wrote it said it (the LinkedIn message a reply
	 * is to). Shown above the text so it is read in context. Not part of what is approved:
	 * it is not sent, so it is not in `content_hash`.
	 */
	context: z.string().nullable().optional(),
	/** The exact text that would go out. */
	body: z.string(),
	/** Longest body the channel accepts, when it has a limit worth showing. */
	maxLength: z.number().int().positive().nullable(),
	/** Required fields that are empty. While any is missing the draft cannot be approved. */
	missing: z.array(z.string()),
	/** Things to see before approving, in plain words. */
	warnings: z.array(z.string()),
	/**
	 * Fingerprint of what would go out (recipients, subject, text). An approval is bound to
	 * it: send this back when approving so a draft that changed since it was drawn is refused.
	 */
	content_hash: z.string(),
	/** Where the draft stands. Absent when the endpoint did not look it up. */
	delivery: z
		.object({
			state: z.enum(['draft', 'approved', 'sent']),
			at: z.string().nullable(),
		})
		.optional(),
})

export type ObjectPreview = z.infer<typeof objectPreviewSchema>
export type PreviewRecipient = z.infer<typeof previewRecipientSchema>
export type PreviewDetail = z.infer<typeof previewDetailSchema>

/** The metadata key that makes an object previewable. */
export const PREVIEW_KIND_KEY = 'kind'
