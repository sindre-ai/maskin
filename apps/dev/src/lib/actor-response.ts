import type { actors } from '@maskin/db/schema'
import { reshapeNotificationPrefs } from '@maskin/shared'
import type { z } from 'zod'
import { logger } from './logger'
import type { actorResponseSchema, actorWithKeySchema } from './openapi-schemas'
import { serialize } from './serialize'

type ActorRow = typeof actors.$inferSelect
// Loosened JSONB type the OpenAPI schema generator emits. We keep our actual
// reshaping honest above; this just satisfies the recursive `jsonbField` type.
type JsonbField = z.infer<typeof actorResponseSchema>['tools']

// Strip secrets and reshape an `actors` row to the wire schema (snake_case keys,
// dates serialized to ISO strings). Centralized so the camelCase → snake_case
// mapping for the profile fields lives in one place. A notification_prefs
// safeParse failure means schema drift or a corrupt JSONB row — log it with the
// actor id so the offending row can be located; the shared helper still returns
// a full default NotificationPrefs so the wire stays non-nullable.
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
		notification_prefs: reshapeNotificationPrefs(serialized.notificationPrefs, (issues) =>
			logger.warn('Notification prefs schema mismatch', {
				actorId: serialized.id,
				issues,
			}),
		),
		pending_email: serialized.pendingEmail,
		system_prompt: serialized.systemPrompt,
		tools: serialized.tools as JsonbField,
		memory: serialized.memory as JsonbField,
		llm_provider: serialized.llmProvider,
		llm_config: serialized.llmConfig as JsonbField,
		isSystem: serialized.isSystem,
		agentState: serialized.agentState,
		agentStateUpdatedAt: serialized.agentStateUpdatedAt,
		createdAt: serialized.createdAt,
		updatedAt: serialized.updatedAt,
		installedPackageId:
			(serialized.metadata as { installed_package_id?: string } | null | undefined)
				?.installed_package_id ?? null,
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
