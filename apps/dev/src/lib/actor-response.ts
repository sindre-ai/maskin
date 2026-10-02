import type { z } from '@hono/zod-openapi'
import type { actors } from '@maskin/db/schema'
import { actorWithKeySchema } from './openapi-schemas'
import { serialize } from './serialize'

/**
 * Builds the `{ ...actor, api_key }` body returned by signup and login.
 *
 * The result is parsed through `actorWithKeySchema`, which strips every key the
 * schema doesn't declare. That makes the response an ALLOWLIST: a new secret
 * column on `actors` (like `password_hash`, which signup once returned) can't
 * leak by default, whereas a destructure-out list has to be remembered.
 */
export function toActorWithKeyResponse(
	actor: typeof actors.$inferSelect,
	apiKey: string,
	extra: { workspace_id?: string; workspace_provisioning_failed?: true } = {},
): z.infer<typeof actorWithKeySchema> {
	const { systemPrompt, llmProvider, llmConfig, ...rest } = actor
	return actorWithKeySchema.parse({
		...serialize(rest),
		system_prompt: systemPrompt,
		llm_provider: llmProvider,
		llm_config: llmConfig,
		api_key: apiKey,
		...extra,
	})
}
