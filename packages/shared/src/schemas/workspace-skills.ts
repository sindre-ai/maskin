import { z } from 'zod'
import { skillNameSchema } from './skills'

export const workspaceSkillSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: skillNameSchema,
	description: z.string().nullable(),
	content: z.string(),
	storageKey: z.string(),
	sizeBytes: z.number().int().nonnegative(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export type WorkspaceSkill = z.infer<typeof workspaceSkillSchema>

export const MAX_WORKSPACE_SKILL_CONTENT_BYTES = 256_000

export const createWorkspaceSkillSchema = z.object({
	name: skillNameSchema,
	content: z.string().min(1).max(MAX_WORKSPACE_SKILL_CONTENT_BYTES),
})

export type CreateWorkspaceSkillInput = z.infer<typeof createWorkspaceSkillSchema>

export const updateWorkspaceSkillSchema = z.object({
	content: z.string().min(1).max(MAX_WORKSPACE_SKILL_CONTENT_BYTES),
})

export type UpdateWorkspaceSkillInput = z.infer<typeof updateWorkspaceSkillSchema>

export const attachSkillSchema = z.object({
	workspaceSkillId: z.string().uuid(),
})

export type AttachSkillInput = z.infer<typeof attachSkillSchema>
