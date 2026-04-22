import { z } from 'zod'

/** Relationship types that connect an object to an actor (assignment / watching). */
export const PARTICIPANT_RELATIONSHIP_TYPES = ['assigned_to', 'watches'] as const
export type ParticipantRelationshipType = (typeof PARTICIPANT_RELATIONSHIP_TYPES)[number]

export const createRelationshipSchema = z
	.object({
		source_type: z.string(),
		source_id: z.string().uuid(),
		target_type: z.string(),
		target_id: z.string().uuid(),
		type: z.string(),
	})
	.superRefine((val, ctx) => {
		// Participant edges only make sense from an object to an actor.
		if ((PARTICIPANT_RELATIONSHIP_TYPES as readonly string[]).includes(val.type)) {
			if (val.source_type !== 'object' || val.target_type !== 'actor') {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Relationship type '${val.type}' requires source_type='object' and target_type='actor'`,
					path: ['type'],
				})
			}
		}
	})

export const relationshipQuerySchema = z.object({
	source_id: z.string().uuid().optional(),
	target_id: z.string().uuid().optional(),
	type: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})

export const relationshipParamsSchema = z.object({
	id: z.string().uuid(),
})
