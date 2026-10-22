import type { Database, Transaction } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { checkCredentialName, credentialNameMessage, credentialSlug } from '@maskin/shared'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'

export class CredentialNameError extends Error {
	constructor(
		readonly status: 400 | 409,
		readonly code: 'BAD_REQUEST' | 'NAME_LOOKS_LIKE_SECRET' | 'NAME_TAKEN',
		message: string,
	) {
		super(message)
		this.name = 'CredentialNameError'
	}
}

/**
 * The name rule every bring-your-own API key goes through, from the paste form and
 * from chat. The message never repeats the name: a name that looks like a secret may
 * be one.
 */
export function assertValidCredentialName(name: string): void {
	const problem = checkCredentialName(name)
	if (problem === null) return
	throw new CredentialNameError(
		400,
		problem === 'looks_like_secret' ? 'NAME_LOOKS_LIKE_SECRET' : 'BAD_REQUEST',
		credentialNameMessage(problem),
	)
}

/**
 * Throws NAME_TAKEN when another bring-your-own key or login in the workspace is active or
 * waiting out its undo window under the same env var slug. Slugs are compared, not
 * display names, because the slug is what the agent reads. An undone key has given
 * its name back; a pending_undo one still holds it. `exceptIntegrationId` leaves one row out, so a
 * credential can be renamed to a name that differs only in case or spacing from its own.
 */
export async function assertSlugFree(
	db: Database | Transaction,
	workspaceId: string,
	name: string,
	exceptIntegrationId?: string,
): Promise<void> {
	const slug = credentialSlug(name)
	const rows = await db
		.select({ displayName: integrations.displayName })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				inArray(integrations.providerMode, ['byo_apikey', 'byo_login']),
				inArray(integrations.status, ['active', 'pending_undo']),
				exceptIntegrationId ? ne(integrations.id, exceptIntegrationId) : undefined,
			),
		)
	if (rows.some((r) => r.displayName !== null && credentialSlug(r.displayName) === slug)) {
		throw new CredentialNameError(
			409,
			'NAME_TAKEN',
			'Another key in this workspace already has this name. Pick a different one.',
		)
	}
}

/**
 * Serialises vaults of one slug in one workspace until the transaction ends, so the
 * check that follows sees every earlier commit. Without it two concurrent vaults of
 * the same name could both pass the check. No schema change: the lock is advisory.
 */
export async function lockCredentialSlug(
	tx: Transaction,
	workspaceId: string,
	name: string,
): Promise<void> {
	const key = `byo-apikey-slug:${workspaceId}:${credentialSlug(name)}`
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`)
}
