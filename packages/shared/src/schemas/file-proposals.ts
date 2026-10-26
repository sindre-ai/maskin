import { z } from 'zod'

// Limits on one submit (tech spec: agent change proposals, Decision 2).
export const MAX_PROPOSAL_CHANGES = 50
export const MAX_PROPOSAL_OLD_TEXT = 4000
export const MAX_PROPOSAL_NEW_TEXT = 8000
export const MAX_PROPOSAL_REASON = 1000
export const MAX_PROPOSAL_SUMMARY = 1000

export const proposedChangeSchema = z.object({
	old_text: z.string().min(1).max(MAX_PROPOSAL_OLD_TEXT),
	new_text: z.string().max(MAX_PROPOSAL_NEW_TEXT),
	reason: z.string().max(MAX_PROPOSAL_REASON).optional(),
})

export type ProposedChange = z.infer<typeof proposedChangeSchema>

export const createFileProposalSchema = z.object({
	summary: z.string().max(MAX_PROPOSAL_SUMMARY).optional(),
	changes: z.array(proposedChangeSchema).min(1).max(MAX_PROPOSAL_CHANGES),
})

export type CreateFileProposalInput = z.infer<typeof createFileProposalSchema>

export const createFileProposalResponseSchema = z.object({
	proposalId: z.string().uuid(),
	fileId: z.string().uuid(),
	url: z.string(),
	changeCount: z.number().int(),
})

export type CreateFileProposalResponse = z.infer<typeof createFileProposalResponseSchema>

export const fileProposalStatusSchema = z.enum(['open'])

export const listFileProposalsQuerySchema = z.object({
	status: fileProposalStatusSchema.default('open'),
})

export const fileProposalChangeSchema = z.object({
	id: z.string().uuid(),
	ordinal: z.number().int(),
	oldText: z.string(),
	newText: z.string(),
	reason: z.string().nullable(),
	contextBefore: z.string(),
	contextAfter: z.string(),
	status: z.enum(['pending', 'accepted', 'rejected']),
	decidedBy: z.string().uuid().nullable(),
	decidedAt: z.string().nullable(),
	appliedText: z.string().nullable(),
	// Computed on every read: true when oldText no longer occurs exactly once
	// in the file's current bytes. Never stored.
	stale: z.boolean(),
})

export type FileProposalChangeDto = z.infer<typeof fileProposalChangeSchema>

export const fileProposalSchema = z.object({
	id: z.string().uuid(),
	fileId: z.string().uuid(),
	author: z.object({
		id: z.string().uuid(),
		name: z.string(),
		type: z.string(),
	}),
	sessionId: z.string().uuid().nullable(),
	summary: z.string().nullable(),
	// Softer hint: the file's bytes differ from when the proposal was made.
	fileChangedSinceProposed: z.boolean(),
	createdAt: z.string(),
	changes: z.array(fileProposalChangeSchema),
})

export type FileProposalDto = z.infer<typeof fileProposalSchema>

export const listFileProposalsResponseSchema = z.object({
	proposals: z.array(fileProposalSchema),
})
