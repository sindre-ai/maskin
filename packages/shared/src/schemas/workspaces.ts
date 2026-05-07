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
			// `null` on PATCH signals deletion of that provider; see the deep-merge
			// in PATCH /api/workspaces/:id.
			anthropic: z.string().nullable().optional(),
			openai: z.string().nullable().optional(),
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
	// Bring-your-own model: when enabled, sessions point Claude Code at this
	// endpoint via ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL. Works for OpenRouter,
	// self-hosted vLLM/Ollama, LM Studio — anything speaking the Anthropic
	// Messages API. Takes precedence over Claude OAuth + workspace api keys.
	// `null` on api_key signals deletion (mirrors llm_keys deep-merge convention).
	custom_llm: z
		.object({
			enabled: z.boolean().default(false),
			base_url: z.string().url().nullable().optional(),
			api_key: z.string().nullable().optional(),
			model: z.string().nullable().optional(),
			small_fast_model: z.string().nullable().optional(),
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
