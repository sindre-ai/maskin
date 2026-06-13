import { generateApiKey } from '@maskin/auth'
import type { actors, integrations, triggers, workspaceSkills } from '@maskin/db/schema'

/**
 * Shared provisioning helpers for the managed catalog. Both the install
 * endpoint (`POST /api/installed-packages`) and the version-push cron
 * (`PackageVersionPusher`) build element rows from `catalog_package_items`
 * snapshots — they must produce identical rows or the cron will overwrite
 * installs with subtly different shapes on the next tick.
 */

export type CatalogItemType = 'actor' | 'trigger' | 'skill' | 'integration'

/**
 * Build the per-row metadata for an install-provisioned element. Carries the
 * install id + source item id (so the cron finds the row again next push) plus
 * the snapshot itself (so we can diff against the catalog without scraping the
 * row's structured columns — which differ per element type).
 */
export function installMetadata(
	installId: string,
	sourceItemId: string,
	snapshot: Record<string, unknown>,
): Record<string, unknown> {
	return {
		installed_package_id: installId,
		source_item_id: sourceItemId,
		snapshot,
	}
}

/**
 * Rewrite intra-package wiring in a snapshot. Any string value in the snapshot
 * that matches a known `source_item_id` is replaced with the local id it was
 * provisioned into. Used so a trigger's `target_actor_id` (which points at the
 * publisher's actor id) becomes the installed actor's id.
 */
export function rewriteWiring(
	snapshot: Record<string, unknown>,
	sourceToLocal: Map<string, string>,
): Record<string, unknown> {
	if (sourceToLocal.size === 0) return snapshot
	return walk(snapshot, sourceToLocal) as Record<string, unknown>
}

function walk(value: unknown, sourceToLocal: Map<string, string>): unknown {
	if (typeof value === 'string') {
		const local = sourceToLocal.get(value)
		return local ?? value
	}
	if (Array.isArray(value)) {
		return value.map((v) => walk(v, sourceToLocal))
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = walk(v, sourceToLocal)
		}
		return out
	}
	return value
}

/**
 * Inserts (used by the install endpoint and the cron's "add" branch when
 * re-provisioning a locked install picks up a catalog item that isn't yet
 * installed). Defaults are conservative — the snapshot may have been taken
 * from a workspace with a different column shape, so each accessor tolerates
 * both camelCase and snake_case keys.
 */
export function buildActorInsert(
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string | null,
): typeof actors.$inferInsert {
	// Always mint a fresh apiKey. The snapshot is untrusted input from the
	// publishing workspace — honoring `snapshot.apiKey` would either copy the
	// publisher's bearer token into the installer's workspace (auth leak) or
	// collide on the unique index. apiKey is a real auth credential; it must
	// be generated locally via the cryptographically-secure helper.
	return {
		type: (snapshot.type as string) ?? 'agent',
		name: (snapshot.name as string) ?? 'Untitled agent',
		description: (snapshot.description as string) ?? null,
		systemPrompt: (snapshot.systemPrompt as string) ?? (snapshot.system_prompt as string) ?? null,
		llmProvider: (snapshot.llmProvider as string) ?? (snapshot.llm_provider as string) ?? null,
		llmConfig:
			(snapshot.llmConfig as Record<string, unknown>) ??
			(snapshot.llm_config as Record<string, unknown>) ??
			null,
		tools: (snapshot.tools as Record<string, unknown>) ?? null,
		apiKey: generateApiKey().key,
		metadata,
		createdBy,
	}
}

export function buildTriggerInsert(
	workspaceId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string,
): typeof triggers.$inferInsert {
	return {
		workspaceId,
		name: (snapshot.name as string) ?? 'Untitled trigger',
		type: (snapshot.type as string) ?? 'cron',
		config: (snapshot.config as Record<string, unknown>) ?? {},
		actionPrompt: (snapshot.actionPrompt as string) ?? (snapshot.action_prompt as string) ?? '',
		targetActorId: (snapshot.targetActorId as string) ?? (snapshot.target_actor_id as string) ?? '',
		enabled: typeof snapshot.enabled === 'boolean' ? snapshot.enabled : true,
		createdBy,
		metadata,
	}
}

export function buildSkillInsert(
	workspaceId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string | null,
): typeof workspaceSkills.$inferInsert {
	return {
		workspaceId,
		name: (snapshot.name as string) ?? 'untitled-skill',
		description: (snapshot.description as string) ?? null,
		content: (snapshot.content as string) ?? '',
		storageKey: (snapshot.storageKey as string) ?? (snapshot.storage_key as string) ?? '',
		sizeBytes:
			typeof snapshot.sizeBytes === 'number'
				? snapshot.sizeBytes
				: typeof snapshot.size_bytes === 'number'
					? (snapshot.size_bytes as number)
					: 0,
		isValid: typeof snapshot.isValid === 'boolean' ? snapshot.isValid : true,
		metadata,
		createdBy,
	}
}

export function buildIntegrationInsert(
	workspaceId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string,
): typeof integrations.$inferInsert {
	// Always force status='inactive' on install. Snapshots cannot carry real
	// credentials (those are workspace-scoped encrypted tokens), so the only
	// usable post-install state is "needs reconnect" — the user re-runs OAuth
	// from the installer workspace. Honoring snapshot.status could leave a
	// fresh install marked 'active' with an empty credentials string, which
	// would 500 the first decrypt() the moment anything reads it.
	return {
		workspaceId,
		provider: (snapshot.provider as string) ?? 'unknown',
		status: 'inactive',
		externalId: (snapshot.externalId as string) ?? (snapshot.external_id as string) ?? null,
		credentials: '',
		config: (snapshot.config as Record<string, unknown>) ?? {},
		createdBy,
		metadata,
	}
}
