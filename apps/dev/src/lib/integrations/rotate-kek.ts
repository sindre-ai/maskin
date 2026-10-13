import { AwsKmsProvider, type KmsProvider, type RotateKekOptions } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { workspaceKmsAliases } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../analytics/posthog'
import { logger } from '../logger'

export type RotateKekResult =
	| { status: 'rotated'; previousAlias: string; alias: string }
	| { status: 'skipped'; reason: 'lock_held' | 'not_aws_kms' | 'no_alias' }
	| { status: 'failed'; error: string }

/**
 * Moves a workspace onto a new KEK version. Operator-initiated (see
 * scripts/rotate-kek.ts and the runbook): nothing schedules it.
 *
 * Nothing is re-encrypted here. New wraps use the new key from the moment
 * workspace_kms_aliases.kek_alias changes; existing DEKs keep decrypting under the
 * key that wrapped them (the old alias stays on the old key) and are re-wrapped
 * lazily by the nightly DEK rotation or POST /api/integrations/:id/rotate-dek. This
 * never schedules a key for deletion, and never calls UpdateAlias.
 *
 * Order, so a failure anywhere keeps the old key live: take the per-workspace lock,
 * find or create the new key and alias, prove a round trip on the new alias
 * (AccessDenied is retried for a few minutes while the alias propagates), and only
 * then write kek_alias. If the probe never passes, the row is left alone and a
 * PostHog event and an error log say so.
 *
 * The lock is a session-level Postgres advisory lock on one reserved connection
 * for the whole run, taken BEFORE CreateKey. A key cannot be deleted by the
 * runtime role, so a loser that created a key would leave an orphan for good; the
 * loser skips instead. A transaction-level lock would pin a pooled connection for
 * the retry window. A crash drops the connection and frees the lock. Retrying after
 * a crash computes the same next version and reuses the alias if it exists.
 */
export async function rotateWorkspaceKek(
	db: Database,
	kms: KmsProvider,
	workspaceId: string,
	options: Pick<RotateKekOptions, 'probeTimeoutMs' | 'probeIntervalMs' | 'sleep'> = {},
): Promise<RotateKekResult> {
	if (!(kms instanceof AwsKmsProvider)) return { status: 'skipped', reason: 'not_aws_kms' }

	const [current] = await db
		.select({ kekAlias: workspaceKmsAliases.kekAlias })
		.from(workspaceKmsAliases)
		.where(eq(workspaceKmsAliases.workspaceId, workspaceId))
		.limit(1)
	if (!current) return { status: 'skipped', reason: 'no_alias' }

	const connection = await db.$client.reserve()
	const lockKey = `keychain-kek-rotation:${workspaceId}`
	try {
		const [lock] = await connection`
			SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked
		`
		if (!lock?.locked) return { status: 'skipped', reason: 'lock_held' }
		try {
			const next = await kms.rotateKek(workspaceId, {
				...options,
				onKeyCreated: ({ alias, keyId }) =>
					logger.info('Keychain KEK rotation created a key', { workspaceId, alias, keyId }),
			})
			// The switch, last. Only moves forward from the alias this run started from.
			const switched = await db
				.update(workspaceKmsAliases)
				.set({ kekAlias: next.alias })
				.where(
					and(
						eq(workspaceKmsAliases.workspaceId, workspaceId),
						eq(workspaceKmsAliases.kekAlias, next.previousAlias),
					),
				)
				.returning({ workspaceId: workspaceKmsAliases.workspaceId })
			if (switched.length === 0) {
				throw new Error('kek_alias changed while rotating; left as it is')
			}
			logger.info('Keychain KEK rotated', { workspaceId, ...next })
			void capturePosthogEvent('keychain_kek_rotated', `workspace:${workspaceId}`, {
				workspace_id: workspaceId,
				from_alias: next.previousAlias,
				to_alias: next.alias,
				reused_existing_alias: next.reusedExistingAlias,
			})
			return { status: 'rotated', previousAlias: next.previousAlias, alias: next.alias }
		} catch (err) {
			const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
			logger.error('Keychain KEK rotation failed; the old key stays live', { workspaceId, error })
			void capturePosthogEvent('keychain_kek_rotation_failed', `workspace:${workspaceId}`, {
				workspace_id: workspaceId,
				error,
			})
			return { status: 'failed', error }
		} finally {
			await connection`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`
		}
	} finally {
		connection.release()
	}
}
