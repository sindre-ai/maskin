import { z } from 'zod'

const fieldDefinitionSchema = z.object({
	name: z.string(),
	type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
	required: z.boolean().default(false),
	values: z.array(z.string()).optional(),
})

// Per-type Hero Card render annotations. The MCP widget reads object metadata
// from these to render any type without per-type widget code — a workspace can
// expose a new object type as a Hero Card simply by adding an entry here.
const heroCardMetaSchema = z.object({
	label: z.string(),
	field: z.string().optional(),
})

const heroCardPrimaryActionSchema = z.object({
	label: z.string(),
	kind: z.string(),
})

const heroCardTypeAnnotationSchema = z.object({
	hero_card_context: z.string().optional(),
	hero_card_metas: z.array(heroCardMetaSchema).optional(),
	primary_action: heroCardPrimaryActionSchema.optional(),
})

export type HeroCardTypeAnnotation = z.infer<typeof heroCardTypeAnnotationSchema>

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
	hero_card: z.record(heroCardTypeAnnotationSchema).default({}),
	relationship_types: z
		.array(z.string())
		.default(['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates']),
	custom_extensions: z.record(customExtensionEntrySchema).default({}),
	enabled_modules: z.array(z.string()).default(['work']),
	max_concurrent_sessions: z.coerce.number().int().min(1).max(50).default(3),
	llm_keys: z
		.object({
			// `null` on PATCH signals deletion of that provider; see the deep-merge
			// in PATCH /api/workspaces/:id. Empty / whitespace-only strings are
			// rejected so a no-op write doesn't drag the BYOLLM ↔ paid plan mutex
			// through a cancel + downgrade for a key that stores nothing usable.
			anthropic: z
				.string()
				.refine((v) => v.trim().length > 0, { message: 'anthropic key cannot be empty' })
				.nullable()
				.optional(),
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
	// Privacy & data block surfaced in workspace Settings → General.
	// `share_usage` toggles posthog opt-in capturing; `anonymize_workspace` swaps
	// the distinct_id for a SHA-256 hash before identify so the Synthesizer's
	// property-keyed joins keep working without raw IDs leaving the browser.
	privacy: z
		.object({
			share_usage: z.boolean().default(true),
			anonymize_workspace: z.boolean().default(false),
		})
		.default({ share_usage: true, anonymize_workspace: false }),
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
	// Maskin-funded LLM subscription. When `plan` is `starter` or `pro` the
	// session routes through Maskin's OpenRouter account (Deepseek v4 Flash),
	// and usage is attributed to the current billing period via
	// `sessions.config.llm_route = 'maskin_plan'`. Mutually exclusive with
	// `custom_llm` / Claude OAuth / workspace `llm_keys.anthropic` at the
	// write layer; the router enforces the precedence at read time.
	// `period_start`, `period_end`, and `hard_cap_tokens` are written by the
	// Stripe webhook; `status` mirrors the Stripe subscription status string.
	// `period_end` is the Stripe `current_period_end` — surfaced on the
	// `PLAN_CAP_EXCEEDED` error so the frontend can show a reset ETA.
	billing: z
		.object({
			plan: z.enum(['trial', 'starter', 'pro', 'byollm']),
			stripe_customer_id: z.string().nullable().optional(),
			stripe_subscription_id: z.string().nullable().optional(),
			period_start: z.number().nullable().optional(),
			period_end: z.number().nullable().optional(),
			hard_cap_tokens: z.number().nullable().optional(),
			status: z.enum(['active', 'past_due', 'canceled', 'incomplete']).optional(),
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
