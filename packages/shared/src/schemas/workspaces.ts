import { z } from 'zod'

export const fieldDefinitionSchema = z.object({
	name: z.string(),
	type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
	required: z.boolean().default(false),
	values: z.array(z.string()).optional(),
})

export const objectTypeDefinitionSchema = z.object({
	slug: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'Must be lowercase alphanumeric with underscores'),
	display_name: z.string().min(1),
	icon: z.string().optional(),
	color: z.string().optional(),
	statuses: z.array(z.string()).min(1),
	default_status: z.string().optional(),
	field_definitions: z.array(fieldDefinitionSchema).default([]),
	source: z.enum(['core', 'custom', 'extension']).default('custom'),
	extension_id: z.string().optional(),
})

export type ObjectTypeDefinition = z.infer<typeof objectTypeDefinitionSchema>

export const workspaceSettingsSchema = z.object({
	object_types: z.array(objectTypeDefinitionSchema).default([
		{
			slug: 'insight',
			display_name: 'Insight',
			icon: 'lightbulb',
			color: 'amber',
			statuses: ['new', 'processing', 'clustered', 'discarded'],
			default_status: 'new',
			field_definitions: [],
			source: 'core',
		},
		{
			slug: 'bet',
			display_name: 'Bet',
			icon: 'target',
			color: 'indigo',
			statuses: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
			default_status: 'signal',
			field_definitions: [],
			source: 'core',
		},
		{
			slug: 'task',
			display_name: 'Task',
			icon: 'check-square',
			color: 'emerald',
			statuses: ['todo', 'in_progress', 'done', 'blocked'],
			default_status: 'todo',
			field_definitions: [],
			source: 'core',
		},
	]),
	// Kept for backwards compatibility — object_types is the source of truth
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
	max_concurrent_sessions: z.coerce.number().int().min(1).max(50).default(5),
	llm_keys: z
		.object({
			anthropic: z.string().optional(),
			openai: z.string().optional(),
		})
		.default({}),
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
	template: z.enum(['product', 'crm', 'blank']).optional(),
})

export const updateWorkspaceSchema = z.object({
	name: z.string().min(1).optional(),
	settings: workspaceSettingsSchema.partial().optional(),
})

export const workspaceParamsSchema = z.object({
	id: z.string().uuid(),
})
