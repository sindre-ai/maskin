import { z } from 'zod'

// ── Custom (bring-your-own) extensions ──────────────────────────────────────
// Shapes for the JSONB columns on `extensions` (packages/db/src/schema.ts) and
// the API that writes them. Validated on every write; the column types in the
// db package are inferred from here so the two cannot drift.

/** Cap on declared tools per extension. Keeps every session's tool schema small. */
export const MAX_EXTENSION_TOOLS = 20

export const extensionSlugSchema = z
	.string()
	.min(2)
	.max(48)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes')

export const extensionStatusSchema = z.enum(['active', 'disabled', 'draft'])
export type ExtensionStatus = z.infer<typeof extensionStatusSchema>

export const mcpConfigSchema = z.object({
	/** Env var name the child process reads. */
	envKey: z.string(),
	server: z.discriminatedUnion('type', [
		z.object({
			type: z.literal('stdio'),
			command: z.string(),
			args: z.array(z.string()),
			/** Env var that receives "Bearer " + the decrypted credential. */
			envFromCredential: z.string().optional(),
		}),
		// Kept in the schema, not supported by the V1 runtime.
		z.object({ type: z.literal('http'), url: z.string().url() }),
	]),
	autoInject: z.boolean().default(true),
	/** The integrations.provider slug holding the MCP API key: 'extension-mcp:{slug}'. */
	credentialProvider: z.string(),
	tools: z
		.array(
			z.object({
				name: z.string(),
				kind: z.enum(['read', 'write']),
				description: z.string().optional(),
			}),
		)
		.max(MAX_EXTENSION_TOOLS)
		.default([]),
})
export type McpConfig = z.infer<typeof mcpConfigSchema>

const literalOrPathSchema = z.union([
	z.object({ literal: z.string().min(1) }),
	z.object({ path: z.string().min(1) }),
])

export const webhookConfigSchema = z
	.object({
		signatureScheme: z.enum(['hmac-sha256', 'hmac-sha1', 'timestamp']),
		signatureHeader: z.string().min(1),
		signaturePrefix: z.string().optional(),
		timestampHeader: z.string().optional(),
		/** Signing base for the 'timestamp' scheme, e.g. "v0:{timestamp}:{body}". */
		timestampBodyTemplate: z.string().optional(),
		maxAgeSeconds: z.number().int().positive().default(300),
		/** V1 stores the signing secret encrypted per extension. */
		secretSource: z.enum(['env', 'credential']).default('credential'),
		eventMap: z.object({
			externalIdPath: z.string().min(1),
			entityType: literalOrPathSchema,
			action: literalOrPathSchema,
			dataPath: z.string().optional(),
		}),
		rateLimit: z
			.object({ perMinute: z.number().int().positive().default(60) })
			.default({ perMinute: 60 }),
	})
	.superRefine((cfg, ctx) => {
		if (cfg.signatureScheme === 'timestamp') {
			if (!cfg.timestampHeader) {
				ctx.addIssue({
					code: 'custom',
					path: ['timestampHeader'],
					message: 'Required for the timestamp scheme',
				})
			}
			if (!cfg.timestampBodyTemplate) {
				ctx.addIssue({
					code: 'custom',
					path: ['timestampBodyTemplate'],
					message: 'Required for the timestamp scheme',
				})
			}
		}
	})
export type WebhookConfig = z.infer<typeof webhookConfigSchema>

/**
 * One grant value. Plain 'allow' / 'deny' today; the object form carries an
 * expiry for time-boxed grants. No expiry logic reads it yet.
 */
export const toolGrantSchema = z.union([
	z.enum(['allow', 'deny']),
	z.object({
		effect: z.enum(['allow', 'deny']),
		expires_at: z.string().datetime().nullable(),
		grant_id: z.string(),
	}),
])
export type ToolGrant = z.infer<typeof toolGrantSchema>

/** agentId -> toolName -> grant. Absent agent means every tool is denied. */
export const toolGrantsSchema = z.record(z.string(), z.record(z.string(), toolGrantSchema))
export type ToolGrants = z.infer<typeof toolGrantsSchema>

// ── API bodies ──────────────────────────────────────────────────────────────

const mcpApiKeySchema = z.string().min(1).max(2048)

export const createExtensionBodySchema = z.object({
	slug: extensionSlugSchema,
	name: z.string().min(1).max(80),
	status: extensionStatusSchema.optional(),
	mcp_config: mcpConfigSchema.nullish(),
	webhook_config: webhookConfigSchema.nullish(),
	/** Required whenever webhook_config is set (no unsigned webhooks). */
	signing_secret: z.string().min(16).max(512).optional(),
	/** The MCP API key, stored on its own row. Optional: an MCP can take no auth. */
	mcp_api_key: mcpApiKeySchema.optional(),
})
export type CreateExtensionBody = z.infer<typeof createExtensionBodySchema>

// slug is immutable, so the update body does not accept it.
export const updateExtensionBodySchema = z
	.object({
		name: z.string().min(1).max(80).optional(),
		status: extensionStatusSchema.optional(),
		mcp_config: mcpConfigSchema.nullish(),
		webhook_config: webhookConfigSchema.nullish(),
		/** Replaces the stored secret. */
		signing_secret: z.string().min(16).max(512).optional(),
		/** Replaces the stored MCP API key (row extension-mcp:{slug}). Never returned. */
		mcp_api_key: mcpApiKeySchema.optional(),
	})
	.strict()
export type UpdateExtensionBody = z.infer<typeof updateExtensionBodySchema>

// ── Tool grants API bodies ──────────────────────────────────────────────────

/**
 * Grant an agent access to an extension. With no body the agent gets each
 * declared tool's default (read allow, write deny); entries in `tools` override
 * those defaults. Tool names must be declared in mcp_config.tools.
 */
export const setAgentGrantBodySchema = z
	.object({ tools: z.record(z.string(), z.enum(['allow', 'deny'])).optional() })
	.strict()
export type SetAgentGrantBody = z.infer<typeof setAgentGrantBodySchema>

/** Flip one tool for one agent. */
export const setToolGrantBodySchema = z.object({ effect: z.enum(['allow', 'deny']) }).strict()
export type SetToolGrantBody = z.infer<typeof setToolGrantBodySchema>

// ── MCP probe ───────────────────────────────────────────────────────────────

/** Verify & save in the MCP modal: ask the server for its tools before anything is stored. */
export const probeMcpBodySchema = z
	.object({
		server_url: z.string().url().max(2048),
		/** Sent as Authorization: Bearer. Used for this one call, never stored. */
		api_key: mcpApiKeySchema.optional(),
	})
	.strict()
export type ProbeMcpBody = z.infer<typeof probeMcpBodySchema>
