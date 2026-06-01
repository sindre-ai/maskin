import type { actors } from '@maskin/db/schema'
import type { z } from 'zod'
import type { actorResponseSchema, actorWithKeySchema } from './openapi-schemas'
import { serialize } from './serialize'

type ActorRow = typeof actors.$inferSelect
// Loosened JSONB type the OpenAPI schema generator emits. We keep our actual
// reshaping honest above; this just satisfies the recursive `jsonbField` type.
type JsonbField = z.infer<typeof actorResponseSchema>['tools']

// Strip secrets and reshape an `actors` row to the wire schema (snake_case keys,
// dates serialized to ISO strings). Centralized so the camelCase → snake_case
// mapping for the profile fields lives in one place.
export function serializeActor(actor: ActorRow): z.infer<typeof actorResponseSchema> {
	const serialized = serialize(actor)
	return {
		id: serialized.id,
		type: serialized.type,
		name: serialized.name,
		email: serialized.email,
		description: serialized.description,
		bio: serialized.bio,
		avatar_storage_key: serialized.avatarStorageKey,
		notification_prefs: serialized.notificationPrefs as JsonbField,
		pending_email: serialized.pendingEmail,
		system_prompt: serialized.systemPrompt,
		tools: serialized.tools as JsonbField,
		memory: serialized.memory as JsonbField,
		llm_provider: serialized.llmProvider,
		llm_config: serialized.llmConfig as JsonbField,
		isSystem: serialized.isSystem,
		createdAt: serialized.createdAt,
		updatedAt: serialized.updatedAt,
	}
}

export function serializeActorWithKey(
	actor: ActorRow,
	apiKey: string,
	workspaceId?: string,
): z.infer<typeof actorWithKeySchema> {
	const base = serializeActor(actor)
	return {
		...base,
		api_key: apiKey,
		...(workspaceId && { workspace_id: workspaceId }),
	}
}
