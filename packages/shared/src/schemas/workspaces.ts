import { z } from 'zod'

const fieldDefinitionSchema = z.object({
	name: z.string(),
	type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
	required: z.boolean().default(false),
	values: z.array(z.string()).optional(),
})

const customExtensionEntrySchema = z.object({
	name: z.string(),
	types: z.array(z.string()),
	relationship_types: z.array(z.string()).optional(),
	enabled: z.boolean().default(true),
})

export type CustomExtensionEntry = z.infer<typeof customExtensionEntrySchema>

export const workspaceSettingsSchema = z.object({
	display_names: z.record(z.string()).default({
		insight: 'Insight',
		bet: 'Bet',
		task: 'Task',
	}),
	statuses: z.record(z.array(z.string())).default({
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
		task: ['todo', 'in_progress', 'done', 'blocked'],
	}),
	field_definitions: z.record(z.array(fieldDefinitionSchema)).default({}),
	relationship_types: z
		.array(z.string())
		.default(['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates']),
	custom_extensions: z.record(customExtensionEntrySchema).default({}),
	enabled_modules: z.array(z.string()).default(['work']),
	max_concurrent_sessions: z.coerce.number().int().min(1).max(50).default(3),
	llm_keys: z
		.object({
			anthropic: z.string().optional(),
			openai: z.string().optional(),
		})
		.default({}),
	onboarding_completed: z.boolean().default(false),
	claude_oauth: z
		.object({
			encryptedAccessToken: z.string(),
			encryptedRefreshToken: z.string(),
			expiresAt: z.number(),
			subscriptionType: z.string().optional(),
			scopes: z.array(z.string()).optional(),
		})
		.optional(),
})

export const createWorkspaceSchema = z.object({
	name: z.string().min(1),
	settings: workspaceSettingsSchema.optional(),
})

export const updateWorkspaceSchema = z.object({
	name: z.string().min(1).optional(),
	settings: workspaceSettingsSchema.partial().optional(),
})

export const workspaceParamsSchema = z.object({
	id: z.string().uuid(),
})
