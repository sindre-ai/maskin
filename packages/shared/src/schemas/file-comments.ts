import { z } from 'zod'

// { x, y } in [0, 1] of the natural document dimensions — NOT viewport
// fractions. Legacy pins ported from files.annotations preserve their pre-
// refactor viewport-fraction values verbatim under the same schema (drift
// on legacy pins is accepted per spec §Research notes).
export const positionDocSchema = z.object({
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
})

export type PositionDoc = z.infer<typeof positionDocSchema>

export const MAX_FILE_COMMENT_BODY = 4000

export const createFileCommentSchema = z.object({
	body: z.string().min(1).max(MAX_FILE_COMMENT_BODY),
	page: z.number().int().nonnegative().nullable().optional(),
	positionDoc: positionDocSchema,
	selector: z.string().max(1000).nullable().optional(),
	parentId: z.string().uuid().nullable().optional(),
})

export type CreateFileCommentInput = z.infer<typeof createFileCommentSchema>

// PATCH body: `body`, or resolve/reopen. `resolved: true` writes resolvedAt +
// resolvedBy; `resolved: false` clears them. Either or both fields may be
// present; at least one must be, so a body-less no-op PATCH is rejected.
export const updateFileCommentSchema = z
	.object({
		body: z.string().min(1).max(MAX_FILE_COMMENT_BODY).optional(),
		resolved: z.boolean().optional(),
	})
	.refine(
		(o) => o.body !== undefined || o.resolved !== undefined,
		'At least one of body or resolved must be provided',
	)

export type UpdateFileCommentInput = z.infer<typeof updateFileCommentSchema>

// POST /files/:id/comments/rounds — client generates `roundId` at draft time
// so a retried Send from a wobbly client is a no-op after the first success.
export const sendRoundSchema = z.object({
	roundId: z.string().uuid(),
	targetObjectId: z.string().uuid(),
	commentIds: z.array(z.string().uuid()).min(1).max(200),
})

export type SendRoundInput = z.infer<typeof sendRoundSchema>

export const fileCommentSchema = z.object({
	id: z.string().uuid(),
	fileId: z.string().uuid(),
	page: z.number().int().nullable(),
	positionDoc: positionDocSchema,
	selector: z.string().nullable(),
	authorId: z.string().uuid(),
	body: z.string(),
	parentId: z.string().uuid().nullable(),
	roundId: z.string().uuid().nullable(),
	resolvedAt: z.string().nullable(),
	resolvedBy: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export type FileCommentDto = z.infer<typeof fileCommentSchema>

export const sendRoundResponseSchema = z.object({
	roundId: z.string().uuid(),
	count: z.number().int().nonnegative(),
	rollupEventId: z.number().int().nonnegative(),
	comments: z.array(fileCommentSchema),
})

export type SendRoundResponse = z.infer<typeof sendRoundResponseSchema>

// Error codes returned by the round endpoint's attaching-object validation
// (spec §Attaching-object lookup rules).
export const FILE_COMMENTS_ROUND_ERROR_CODES = {
	NO_ATTACHER: 'NO_ATTACHER',
	WRONG_TARGET: 'WRONG_TARGET',
	TARGET_ARCHIVED: 'TARGET_ARCHIVED',
	RATE_LIMITED: 'RATE_LIMITED',
} as const

export type FileCommentsRoundErrorCode =
	(typeof FILE_COMMENTS_ROUND_ERROR_CODES)[keyof typeof FILE_COMMENTS_ROUND_ERROR_CODES]

// Rate limit — 10 rounds per user per rolling 60s window on the round
// endpoint, so a single wobbly client can't spam the driver's For You feed.
export const ROUND_RATE_LIMIT_PER_MINUTE = 10
export const ROUND_RATE_LIMIT_WINDOW_MS = 60_000
