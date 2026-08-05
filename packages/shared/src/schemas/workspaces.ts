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

const claudeOAuthLegacySlotSchema = z
	.object({
		encryptedAccessToken: z.string(),
		encryptedRefreshToken: z.string(),
		expiresAt: z.number(),
		subscriptionType: z.string().optional(),
		scopes: z.array(z.string()).optional(),
	})
	.strict()

const claudeOAuthFailoverStateSchema = z
	.object({
		last_primary_failure_at: z.number().optional(),
		active_slot: z.enum(['primary', 'backup']),
		last_classified_reason: z.string().optional(),
	})
	.strict()

// Strict so malformed-legacy values (e.g. encryptedAccessToken alone) don't
// silently parse as an empty new-shape object — they fail both union branches.
// `.refine()` requires at least one field so `{}` is rejected too — an empty
// object would otherwise validate (every field is optional) and silently wipe
// both slots + failover state for any caller that merges it into settings.
const claudeOAuthSlotStorageSchema = z
	.object({
		primary: claudeOAuthLegacySlotSchema.optional(),
		backup: claudeOAuthLegacySlotSchema.optional(),
		failover: claudeOAuthFailoverStateSchema.optional(),
	})
	.strict()
	.refine((v) => v.primary !== undefined || v.backup !== undefined || v.failover !== undefined, {
		message: 'claude_oauth must define at least one of primary, backup, or failover',
	})

export const workspaceSettingsSchema = z.object({
	display_names: z.record(z.string()).default({
		insight: 'Insight',
		bet: 'Bet',
		task: 'Task',
		commitment: 'Commitment',
		loop: 'Loop',
	}),
	statuses: z.record(z.array(z.string())).default({
		insight: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
		// `archived` is a silent terminal — intentionally NOT in TERMINAL_BET_STATUSES
		// (packages/shared/src/schemas/objects.ts) so archive doesn't fire retro or
		// notification fan-out. Add other terminal states there, not archived.
		bet: [
			'signal',
			'qualified',
			'define',
			'active',
			'live',
			'succeeded',
			'failed',
			'paused',
			'archived',
		],
		task: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
		commitment: ['holding', 'at-risk', 'breached'],
		loop: ['running', 'waiting', 'paused', 'archived'],
	}),
	field_definitions: z.record(z.array(fieldDefinitionSchema)).default({
		bet: [{ name: 'archive_reason', type: 'text', required: false }],
	}),
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
			// in PATCH /api/workspaces/:id.
			anthropic: z.string().nullable().optional(),
			openai: z.string().nullable().optional(),
		})
		.default({}),
	// claude_oauth has two valid on-disk shapes — legacy single-slot (kept for
	// back-compat per AC-T1 of the subscription-failover bet, no migration of
	// existing rows) and the new primary/backup/failover shape introduced by
	// T1. Resolver lives in apps/dev/src/lib/claude-oauth-slots.ts.
	claude_oauth: z.union([claudeOAuthLegacySlotSchema, claudeOAuthSlotStorageSchema]).optional(),
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
	// North Star onboarding prompt answer — stored when a user submits the
	// "What's your product's North Star metric?" card on the For You page.
	north_star_metric: z.string().optional(),
	// Actor id that new chats should open with when the caller doesn't pass an
	// explicit agent (slash-picker overrides still win). `null` — the default
	// on existing workspace rows — keeps the pre-existing per-caller
	// resolution path (Workspace Coach by name) unchanged. Set by the Chief of
	// Staff prototype bet so owner chats route through CoS instead of Workspace
	// Coach when this is populated.
	default_agent_id: z.string().uuid().nullable().optional(),
	// Public "method site" publishing config (ADR #6 on the Publish bet).
	// `enabled` is the master switch — false by default so a workspace opts in
	// before any object metadata surfaces at /method/*. `version` bumps on any
	// publish-visible edit and drives ETag invalidation (ADR-2/ADR-4).
	publish: z
		.object({
			enabled: z.boolean().default(false),
			slug: z.string().optional(),
			title: z.string().optional(),
			description: z.string().optional(),
			visibility: z.enum(['public', 'unlisted']).default('public'),
			version: z.number().int().nonnegative().default(0),
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

export const updateWorkspaceAdminSchema = z.object({
	onboarding_enabled: z.boolean(),
})

export const workspaceParamsSchema = z.object({
	id: z.string().uuid(),
})
