/**
 * Unipile v2 webhook envelope reader.
 *
 * Every delivery is one flat envelope: `id`, `created_at`, `account_id`,
 * `account_provider`, `account_name`, `type` and the event resource under
 * `payload`. The reader is deliberately shallow: one level of nesting, no
 * fallbacks into the resource for the account id.
 *
 * `type` falls back to `event` because Unipile v1 used that key and the shipped
 * account.reconnect parser accepted both, so a version drift must not silently
 * no-op every delivery.
 */

export interface UnipileEnvelope {
	/** `body.type`, falling back to `body.event`. */
	type: string | null
	/** `body.account_id` only. */
	accountId: string | null
	/** `body.id`: the envelope id, used for the envelope dedupe claim. */
	envelopeId: string | null
	/** `body.payload`: the event resource (a Message for message.new). */
	resource: Record<string, unknown> | null
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readUnipileEnvelope(body: unknown): UnipileEnvelope {
	if (!isRecord(body)) {
		return { type: null, accountId: null, envelopeId: null, resource: null }
	}
	return {
		type: nonEmptyString(body.type) ?? nonEmptyString(body.event),
		accountId: nonEmptyString(body.account_id),
		envelopeId: nonEmptyString(body.id),
		resource: isRecord(body.payload) ? body.payload : null,
	}
}
