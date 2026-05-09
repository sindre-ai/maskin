import { z } from 'zod'

// ── Enums ────────────────────────────────────────────────────────────────────

export const threadVisibilitySchema = z.enum(['channel', 'private'])
export type ThreadVisibility = z.infer<typeof threadVisibilitySchema>

export const threadStateSchema = z.enum(['open', 'waiting', 'resolved', 'archived'])
export type ThreadState = z.infer<typeof threadStateSchema>

export const threadKindSchema = z.enum([
	'needs_input',
	'alert',
	'recommendation',
	'good_news',
	'fyi',
	'discussion',
	'conversation',
])
export type ThreadKind = z.infer<typeof threadKindSchema>

export const threadEventKindSchema = z.enum([
	'message',
	'plan',
	'tool_call',
	'tool_result',
	'edit',
	'join',
	'leave',
	'yield',
	'resolve',
	'archive',
	'system',
])
export type ThreadEventKind = z.infer<typeof threadEventKindSchema>

export const participantKindSchema = z.enum(['human', 'agent'])
export type ParticipantKind = z.infer<typeof participantKindSchema>

// ── Participant ───────────────────────────────────────────────────────────────

export const participantSchema = z.object({
	actorId: z.string().uuid(),
	kind: participantKindSchema,
	joinedAt: z.string(),
})
export type Participant = z.infer<typeof participantSchema>

// ── Thread Event ──────────────────────────────────────────────────────────────

export const threadEventSchema = z.object({
	id: z.string().uuid(),
	threadId: z.string().uuid(),
	actorId: z.string().uuid(),
	kind: threadEventKindSchema,
	body: z.string().nullable(),
	metadata: z
		.record(
			z.string(),
			z.union([
				z.string(),
				z.number(),
				z.boolean(),
				z.null(),
				z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
			]),
		)
		.nullable(),
	createdAt: z.string().nullable(),
})
export type ThreadEvent = z.infer<typeof threadEventSchema>

// ── Thread ────────────────────────────────────────────────────────────────────

export const threadSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	focusObjectId: z.string().uuid().nullable(),
	visibility: threadVisibilitySchema,
	state: threadStateSchema,
	kind: threadKindSchema,
	title: z.string(),
	participants: z.array(participantSchema),
	resolvedAt: z.string().nullable(),
	resolvedBy: z.string().uuid().nullable(),
	resolution: z.string().nullable(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})
export type Thread = z.infer<typeof threadSchema>

// ── Request Schemas ───────────────────────────────────────────────────────────

export const createThreadSchema = z.object({
	title: z.string().min(1).max(500),
	visibility: threadVisibilitySchema.default('channel'),
	kind: threadKindSchema.default('discussion'),
	focus_object_id: z.string().uuid().optional(),
	participant_ids: z.array(z.string().uuid()).optional(),
})
export type CreateThread = z.infer<typeof createThreadSchema>

export const updateThreadSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	state: threadStateSchema.optional(),
	resolution: z.string().optional(),
})
export type UpdateThread = z.infer<typeof updateThreadSchema>

export const createThreadEventSchema = z.object({
	kind: threadEventKindSchema,
	body: z.string().optional(),
	metadata: z
		.record(
			z.string(),
			z.union([
				z.string(),
				z.number(),
				z.boolean(),
				z.null(),
				z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
			]),
		)
		.optional(),
	mentions: z.array(z.string().uuid()).max(20).optional(),
})
export type CreateThreadEvent = z.infer<typeof createThreadEventSchema>

export const addThreadParticipantSchema = z.object({
	actor_id: z.string().uuid(),
	kind: participantKindSchema,
})
export type AddThreadParticipant = z.infer<typeof addThreadParticipantSchema>

export const threadQuerySchema = z.object({
	state: threadStateSchema.optional(),
	visibility: threadVisibilitySchema.optional(),
	focus_object_id: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
})
export type ThreadQuery = z.infer<typeof threadQuerySchema>

export const threadParamsSchema = z.object({
	id: z.string().uuid(),
})

export const threadParticipantParamsSchema = z.object({
	id: z.string().uuid(),
	actorId: z.string().uuid(),
})

export const threadEventQuerySchema = z.object({
	since: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type ThreadEventQuery = z.infer<typeof threadEventQuerySchema>
