import { z } from 'zod'
import { safeMetadataSchema } from './primitives'

/**
 * Response + request shapes for the supervised-loop output approval queue
 * (T7 of bet/loop-lifecycle-status-ladder). One row per held output; the
 * `payload` blob is the delivery-shaped value the loop wanted to hand off,
 * `edited_payload` is populated when the human corrected it before approving.
 *
 * `driver_actor_id` is the agent that produced the output — captured at
 * enqueue time so the reject/correction fan-out can route back as a training
 * signal event without another lookup.
 *
 * The reusable `safeMetadataSchema` bounds `payload` / `edited_payload` to
 * the same JSONB envelope the objects/relationships routes accept, keeping a
 * single Zod contract for what an agent may hand off across the API.
 */
export const loopApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected'])
export type LoopApprovalStatus = z.infer<typeof loopApprovalStatusSchema>

export const loopApprovalResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	loopId: z.string().uuid(),
	sessionId: z.string().uuid().nullable(),
	driverActorId: z.string().uuid().nullable(),
	status: loopApprovalStatusSchema,
	payload: safeMetadataSchema,
	editedPayload: safeMetadataSchema.nullable(),
	correctionNote: z.string().nullable(),
	decidedBy: z.string().uuid().nullable(),
	decidedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export type LoopApprovalResponse = z.infer<typeof loopApprovalResponseSchema>

export const createLoopApprovalSchema = z.object({
	loop_id: z.string().uuid(),
	session_id: z.string().uuid().nullable().optional(),
	driver_actor_id: z.string().uuid().nullable().optional(),
	payload: safeMetadataSchema,
})

export type CreateLoopApprovalInput = z.infer<typeof createLoopApprovalSchema>

/**
 * Approve a pending row. Both fields are optional — the common path is a
 * straight approve. When either is set, the row is stamped with the edit
 * and a `loop_output_corrected` event fans out to the driver as a training
 * signal (in addition to the `loop_output_delivered` event).
 */
export const approveLoopApprovalSchema = z.object({
	edited_payload: safeMetadataSchema.optional(),
	correction_note: z.string().max(2000).optional(),
})

export type ApproveLoopApprovalInput = z.infer<typeof approveLoopApprovalSchema>

export const rejectLoopApprovalSchema = z.object({
	reason: z.string().max(2000).optional(),
})

export type RejectLoopApprovalInput = z.infer<typeof rejectLoopApprovalSchema>

export const listLoopApprovalsQuerySchema = z.object({
	loop_id: z.string().uuid().optional(),
	status: loopApprovalStatusSchema.optional(),
	limit: z.coerce.number().int().positive().max(200).optional().default(50),
	offset: z.coerce.number().int().nonnegative().optional().default(0),
})
