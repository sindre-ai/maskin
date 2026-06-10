import { z } from '@hono/zod-openapi'
import { actorListItemSchema, triggerResponseSchema } from '@maskin/shared'
import { apiErrorSchema } from './errors'

// Re-exported so existing route handlers keep their `from '../lib/openapi-schemas'`
// import path; the canonical definitions live in `@maskin/shared` so the MCP
// server and web client consume the same fields without redeclaring them.
export { actorListItemSchema, triggerResponseSchema }

/**
 * JSON-compatible schema for JSONB fields in OpenAPI response schemas.
 * Uses z.record() instead of z.unknown() because zod-openapi requires
 * response types to extend JSONValue, and unknown doesn't satisfy that.
 */
export const jsonbField = z
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
	.nullable()

export const errorSchema = apiErrorSchema

export const idParamSchema = z.object({ id: z.string().uuid() })

export const workspaceIdHeader = z.object({
	'x-workspace-id': z.string().uuid(),
})

export const objectResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	type: z.string(),
	title: z.string().nullable(),
	content: z.string().nullable(),
	status: z.string(),
	metadata: jsonbField,
	owner: z.string().uuid().nullable(),
	activeSessionId: z.string().uuid().nullable(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	// Per-viewer subscription state. Populated only by detail/graph endpoints
	// (list endpoints omit them to avoid N+1 queries — clients render lists
	// without unread badges).
	is_subscribed: z.boolean().optional(),
	unread_count: z.number().optional(),
	subscriber_count: z.number().optional(),
})

export const actorResponseSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	description: z.string().nullable(),
	system_prompt: z.string().nullable(),
	tools: jsonbField,
	memory: jsonbField,
	llm_provider: z.string().nullable(),
	llm_config: jsonbField,
	isSystem: z.boolean(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export const actorWithKeySchema = actorResponseSchema.extend({
	api_key: z.string(),
	workspace_id: z.string().uuid().optional(),
})

export const actorWithRoleSchema = actorListItemSchema.extend({
	role: z.string(),
})

export const workspaceResponseSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	settings: jsonbField.transform((v) => v ?? {}),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export const relationshipResponseSchema = z.object({
	id: z.string().uuid(),
	sourceType: z.string(),
	sourceId: z.string().uuid(),
	sourceTitle: z.string().nullable().optional(),
	targetType: z.string(),
	targetId: z.string().uuid(),
	targetTitle: z.string().nullable().optional(),
	type: z.string(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
})

export const eventResponseSchema = z.object({
	id: z.number(),
	workspaceId: z.string().uuid(),
	actorId: z.string().uuid(),
	action: z.string(),
	entityType: z.string(),
	entityId: z.string().uuid(),
	data: jsonbField,
	createdAt: z.string().nullable(),
	description: z.string().optional(),
})

export const fileSummarySchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number().int().nonnegative(),
	url: z.string().url(),
})

export const objectGraphResponseSchema = z.object({
	object: objectResponseSchema,
	relationships: z.array(relationshipResponseSchema),
	connected_objects: z.array(objectResponseSchema),
	events: z.array(eventResponseSchema),
	// Every file referenced by this object: attached directly (via an
	// `attached` relationship to a file) or referenced from a comment's
	// `data.attachmentFileIds`. Lets callers resolve file IDs without a
	// follow-up round-trip to /api/files/:id.
	files: z.array(fileSummarySchema),
})

export const integrationResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	provider: z.string(),
	status: z.string(),
	externalId: z.string().nullable(),
	config: jsonbField,
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export const providerEventSchema = z.object({
	entityType: z.string(),
	actions: z.array(z.string()),
	label: z.string(),
})

export const providerInfoSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	authType: z.enum(['oauth2', 'oauth2_custom', 'api_key']),
	events: z.array(providerEventSchema),
})

export const sessionResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	actorId: z.string().uuid(),
	triggerId: z.string().uuid().nullable(),
	status: z.string(),
	containerId: z.string().nullable(),
	actionPrompt: z.string(),
	config: jsonbField,
	interactive: z.boolean(),
	result: jsonbField,
	snapshotPath: z.string().nullable(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	timeoutAt: z.string().nullable(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export const sessionLogResponseSchema = z.object({
	id: z.number(),
	sessionId: z.string().uuid(),
	stream: z.string(),
	content: z.string(),
	createdAt: z.string().nullable(),
})

export const importResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	status: z.string(),
	fileName: z.string(),
	fileType: z.string(),
	totalRows: z.number().nullable(),
	processedRows: z.number(),
	successCount: z.number(),
	errorCount: z.number(),
	mapping: jsonbField,
	preview: jsonbField,
	errors: jsonbField,
	source: z.string(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
})

export const importListItemSchema = importResponseSchema.omit({
	preview: true,
	errors: true,
	mapping: true,
})

export const notificationResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	type: z.string(),
	title: z.string(),
	content: z.string().nullable(),
	metadata: jsonbField,
	sourceActorId: z.string().uuid(),
	targetActorId: z.string().uuid().nullable(),
	objectId: z.string().uuid().nullable(),
	sessionId: z.string().uuid().nullable(),
	status: z.string(),
	resolvedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})
