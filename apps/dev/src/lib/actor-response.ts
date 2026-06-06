import type { actors } from '@maskin/db/schema'
import { type NotificationPrefs, notificationPrefsSchema } from '@maskin/shared'
import type { z } from 'zod'
import { logger } from './logger'
import type { actorResponseSchema, actorWithKeySchema } from './openapi-schemas'
import { serialize } from './serialize'

type ActorRow = typeof actors.$inferSelect
// Loosened JSONB type the OpenAPI schema generator emits. We keep our actual
// reshaping honest above; this just satisfies the recursive `jsonbField` type.
type JsonbField = z.infer<typeof actorResponseSchema>['tools']

// Coerce a row's stored notification_prefs (JSONB, typed `unknown` after
// serialize) into the response shape. Rows written via the PATCH path are
// already a full NotificationPrefs object; rows from login / email-change /
// cancel paths may still hold an empty `{}` from the column default — Zod's
// defaults fill the missing keys so the response always advertises every flag.
// A safeParse failure means schema drift or a corrupt JSONB row: we still
// return null (the caller's contract is nullable), but emit a warn so the
// offending actor is findable.
function reshapeNotificationPrefs(value: unknown, actorId: string): NotificationPrefs | null {
	if (value === null || value === undefined) return null
	const parsed = notificationPrefsSchema.safeParse(value)
	if (parsed.success) return parsed.data
	logger.warn('Notification prefs schema mismatch', {
		actorId,
		issues: parsed.error.issues,
	})
	return null
}

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
		notification_prefs: reshapeNotificationPrefs(serialized.notificationPrefs, serialized.id),
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
