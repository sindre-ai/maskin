import type { Database } from '@maskin/db'
import { MASKED_VALUE, canViewActorSecrets } from './actor-tools-redaction'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the llm_config holds an api_key worth masking. */
export function hasLlmApiKey(llmConfig: unknown): boolean {
	return isRecord(llmConfig) && typeof llmConfig.api_key === 'string' && llmConfig.api_key !== ''
}

/** Copy of the llm_config with api_key replaced by MASKED_VALUE. Model and other keys stay visible. */
export function maskActorLlmConfig(llmConfig: unknown): unknown {
	if (!hasLlmApiKey(llmConfig)) return llmConfig
	return { ...(llmConfig as JsonRecord), api_key: MASKED_VALUE }
}

/** Returns the stored llm_config as-is for the actor itself and admins, masked otherwise. */
export async function redactActorLlmConfigForCaller(
	db: Database,
	callerId: string,
	targetId: string,
	llmConfig: unknown,
): Promise<unknown> {
	if (!hasLlmApiKey(llmConfig)) return llmConfig
	if (await canViewActorSecrets(db, callerId, targetId)) return llmConfig
	return maskActorLlmConfig(llmConfig)
}

/**
 * Write-back for an llm_config that was read masked: a MASKED_VALUE api_key is
 * replaced by the stored one, so a read-modify-write never overwrites the key
 * with the mask.
 *
 * The stored key is only restored when the provider and every key other than
 * api_key and model are unchanged. Otherwise a caller who only sees the mask
 * could re-point the config and have the stored key sent somewhere else.
 *
 * `unresolved` is true when the mask has nothing to restore, so the caller can
 * reject the write.
 */
export function restoreMaskedLlmApiKey(
	incoming: JsonRecord,
	stored: unknown,
	provider: { incoming: string | null | undefined; stored: string | null },
): { llmConfig: JsonRecord; unresolved: boolean } {
	if (incoming.api_key !== MASKED_VALUE) return { llmConfig: incoming, unresolved: false }

	const storedConfig = isRecord(stored) ? stored : {}
	const sameProvider = provider.incoming === undefined || provider.incoming === provider.stored
	const sameShape = Object.entries(incoming).every(
		([key, value]) =>
			key === 'api_key' ||
			key === 'model' ||
			JSON.stringify(value) === JSON.stringify(storedConfig[key]),
	)
	if (!sameProvider || !sameShape || !hasLlmApiKey(storedConfig)) {
		return { llmConfig: incoming, unresolved: true }
	}
	return { llmConfig: { ...incoming, api_key: storedConfig.api_key }, unresolved: false }
}
