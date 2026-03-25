import { z } from '@hono/zod-openapi'

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

export const errorSchema = z.object({ error: z.string() })

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
})

export const actorResponseSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	systemPrompt: z.string().nullable(),
	tools: jsonbField,
	memory: jsonbField,
	llmProvider: z.string().nullable(),
	llmConfig: jsonbField,
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export const actorWithKeySchema = actorResponseSchema.extend({
	api_key: z.string(),
	workspace_id: z.string().uuid().optional(),
})

export const actorListItemSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
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
	targetType: z.string(),
	targetId: z.string().uuid(),
	type: z.string(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
})

export const objectGraphResponseSchema = z.object({
	object: objectResponseSchema,
	relationships: z.array(relationshipResponseSchema),
	connected_objects: z.array(objectResponseSchema),
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
	events: z.array(providerEventSchema),
})

export const triggerResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	type: z.string(),
	config: jsonbField,
	actionPrompt: z.string(),
	targetActorId: z.string().uuid(),
	enabled: z.boolean(),
	createdBy: z.string().uuid(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
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
