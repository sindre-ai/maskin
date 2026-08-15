import { z } from 'zod'
import { loopLifecycleStatusSchema, loopPromotionModeSchema } from './loop-lifecycle'
import { safeMetadataSchema } from './primitives'

/**
 * Read + decision shapes for the loop rung-promotion queue
 * (T5 of bet/loop-lifecycle-status-ladder).
 *
 * A proposal is written by the driver agent when a loop's score climbs past
 * its current rung's threshold. `payload` is the {score, threshold, mode}
 * snapshot the driver used to justify the proposal, kept as-of proposal time
 * so a later approve still shows why the proposal exists even if the score
 * has drifted. Reasoning matches T7's approvals queue: humans need a stable
 * id to act on, not just an event.
 *
 * All decisions are one-way (`pending → approved | rejected | deferred`) and
 * 409 on re-decide.
 */
export const loopPromotionProposalStatusSchema = z.enum([
	'pending',
	'approved',
	'rejected',
	'deferred',
])
export type LoopPromotionProposalStatus = z.infer<typeof loopPromotionProposalStatusSchema>

export const loopPromotionProposalPayloadSchema = z.object({
	score: z.number(),
	threshold: z.number(),
	mode: loopPromotionModeSchema,
})
export type LoopPromotionProposalPayload = z.infer<typeof loopPromotionProposalPayloadSchema>

export const loopPromotionProposalResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	loopId: z.string().uuid(),
	fromStatus: loopLifecycleStatusSchema,
	toStatus: loopLifecycleStatusSchema,
	status: loopPromotionProposalStatusSchema,
	payload: safeMetadataSchema,
	reason: z.string().nullable(),
	proposedBy: z.string().uuid().nullable(),
	decidedBy: z.string().uuid().nullable(),
	decidedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})
export type LoopPromotionProposalResponse = z.infer<typeof loopPromotionProposalResponseSchema>

/** Approve/defer/reject bodies — all optional-only fields; the routes accept
 * an empty body for the common straight-approve or straight-defer path. */
export const decideLoopPromotionSchema = z.object({
	reason: z.string().max(2000).optional(),
})
export type DecideLoopPromotionInput = z.infer<typeof decideLoopPromotionSchema>

export const listLoopPromotionProposalsQuerySchema = z.object({
	loop_id: z.string().uuid().optional(),
	status: loopPromotionProposalStatusSchema.optional(),
	limit: z.coerce.number().int().positive().max(200).optional().default(50),
	offset: z.coerce.number().int().nonnegative().optional().default(0),
})
