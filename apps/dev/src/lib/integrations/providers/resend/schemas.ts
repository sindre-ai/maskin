import { z } from '@hono/zod-openapi'

const attachmentMetadataSchema = z
	.object({
		id: z.string().optional(),
		filename: z.string().optional(),
		content_type: z.string().optional(),
		size: z.number().optional(),
	})
	.passthrough()

/**
 * Resend `email.received` webhook payload. The delivery is metadata-only —
 * `html` / `text` / `headers` / `attachments` sit under `data` only after we
 * fetch the body via the Received Emails API (see `body-fetch.ts`).
 */
export const resendEmailReceivedSchema = z.object({
	type: z.literal('email.received'),
	created_at: z.string().optional(),
	data: z
		.object({
			email_id: z.string().min(1),
			from: z.string().optional(),
			to: z.array(z.string()).optional(),
			cc: z.array(z.string()).optional(),
			bcc: z.array(z.string()).optional(),
			subject: z.string().optional(),
			html: z.string().optional(),
			text: z.string().optional(),
			headers: z.record(z.string()).optional(),
			attachments: z.array(attachmentMetadataSchema).optional(),
		})
		.passthrough(),
})

export type ResendEmailReceived = z.infer<typeof resendEmailReceivedSchema>
