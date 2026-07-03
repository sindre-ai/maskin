import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import { and, eq, ne } from 'drizzle-orm'
import { logger } from '../../../logger'

type InstallationAction =
	| 'created'
	| 'deleted'
	| 'suspend'
	| 'unsuspend'
	| 'new_permissions_accepted'

interface InstallationPayload {
	action?: string
	installation?: {
		id?: number | string
		account?: { login?: string }
	}
}

interface HandleResult {
	kind: 'ignored' | 'reconciled' | 'revoked'
	action: InstallationAction | string
	installationId: string
	details?: Record<string, unknown>
}

/**
 * Handle a GitHub `installation` webhook event.
 *
 * The upstream churn we're gating against: when a user reinstalls the sindre-ai
 * GitHub App on the same org, GitHub issues a *new* installation_id and — since
 * webhooks match integrations rows by external_id (the installation_id) — the
 * previous row silently stops receiving events. Cached tokens under running
 * agent sessions keep pointing at the retired install and 401 on their next
 * REST write.
 *
 * On `installation.created` we look for other active github rows in the same
 * workspace whose owner_login matches, mark them `revoked`, and clean up any
 * stale `pending` rows so the new callback round-trip has a clean slate.
 *
 * On `installation.deleted` / `suspend` we revoke the matching row so the UI
 * stops showing it as connected and downstream code stops trying to mint tokens
 * against a dead installation.
 *
 * The event is delivered with the *new* installation's context, so ownerLogin
 * is taken from `installation.account.login` in the payload — no external API
 * call needed for the reconcile path itself.
 */
export async function handleGithubInstallationEvent(
	db: Database,
	payload: InstallationPayload,
): Promise<HandleResult> {
	const action = payload.action ?? 'unknown'
	const installationId = payload.installation?.id ? String(payload.installation.id) : ''
	const ownerLogin = payload.installation?.account?.login

	if (!installationId) {
		return { kind: 'ignored', action, installationId: '' }
	}

	if (action === 'created' || action === 'new_permissions_accepted') {
		if (!ownerLogin) {
			logger.warn('GitHub installation.created missing account.login — skipping reconcile', {
				installationId,
			})
			return { kind: 'ignored', action, installationId }
		}

		const supersededRows = await db
			.select({
				id: integrations.id,
				workspaceId: integrations.workspaceId,
				externalId: integrations.externalId,
				config: integrations.config,
			})
			.from(integrations)
			.where(
				and(
					eq(integrations.provider, 'github'),
					eq(integrations.status, 'active'),
					ne(integrations.externalId, installationId),
				),
			)

		const matchingSuperseded = supersededRows.filter((row) => {
			const cfg = row.config as { owner_login?: string } | null
			return cfg?.owner_login === ownerLogin
		})

		let revokedCount = 0
		let clearedPending = 0

		if (matchingSuperseded.length > 0) {
			await db.transaction(async (tx) => {
				for (const row of matchingSuperseded) {
					const cfg = row.config as { system_actor_id?: string } | null
					const systemActorId = cfg?.system_actor_id
					if (!systemActorId) {
						logger.warn(
							'GitHub integration row missing system_actor_id — cannot audit revoke; skipping',
							{ integrationId: row.id, workspaceId: row.workspaceId },
						)
						continue
					}

					await tx
						.update(integrations)
						.set({ status: 'revoked', updatedAt: new Date() })
						.where(eq(integrations.id, row.id))

					await tx.insert(events).values({
						workspaceId: row.workspaceId,
						actorId: systemActorId,
						action: 'updated',
						entityType: 'integration',
						entityId: row.id,
						data: {
							status: 'revoked',
							reason: 'superseded_by_reinstall',
							previous_external_id: row.externalId,
							new_external_id: installationId,
							owner_login: ownerLogin,
						},
					})
					revokedCount++
				}
			})

			// Clear stale pending rows for the affected workspaces — the new install
			// callback will create its own fresh pending row and this reduces the
			// unique-index collision surface.
			const affectedWorkspaces = [...new Set(matchingSuperseded.map((r) => r.workspaceId))]
			for (const workspaceId of affectedWorkspaces) {
				const cleared = await db
					.delete(integrations)
					.where(
						and(
							eq(integrations.provider, 'github'),
							eq(integrations.status, 'pending'),
							eq(integrations.workspaceId, workspaceId),
						),
					)
					.returning({ id: integrations.id })
				clearedPending += cleared.length
			}
		}

		logger.info('GitHub installation.created reconciled', {
			installationId,
			ownerLogin,
			revokedCount,
			clearedPending,
		})
		return {
			kind: revokedCount > 0 ? 'reconciled' : 'ignored',
			action,
			installationId,
			details: { ownerLogin, revokedCount, clearedPending },
		}
	}

	if (action === 'deleted' || action === 'suspend') {
		const matching = await db
			.select({
				id: integrations.id,
				workspaceId: integrations.workspaceId,
				config: integrations.config,
			})
			.from(integrations)
			.where(
				and(
					eq(integrations.provider, 'github'),
					eq(integrations.externalId, installationId),
					eq(integrations.status, 'active'),
				),
			)

		if (matching.length === 0) {
			return { kind: 'ignored', action, installationId }
		}

		await db.transaction(async (tx) => {
			for (const row of matching) {
				const cfg = row.config as { system_actor_id?: string } | null
				const systemActorId = cfg?.system_actor_id
				if (!systemActorId) {
					logger.warn(
						'GitHub integration row missing system_actor_id — cannot audit revoke; skipping',
						{ integrationId: row.id, workspaceId: row.workspaceId },
					)
					continue
				}

				await tx
					.update(integrations)
					.set({ status: 'revoked', updatedAt: new Date() })
					.where(eq(integrations.id, row.id))

				await tx.insert(events).values({
					workspaceId: row.workspaceId,
					actorId: systemActorId,
					action: 'updated',
					entityType: 'integration',
					entityId: row.id,
					data: {
						status: 'revoked',
						reason: action === 'deleted' ? 'installation_deleted' : 'installation_suspended',
						installation_id: installationId,
					},
				})
			}
		})

		logger.info(`GitHub installation.${action} — revoked matching rows`, {
			installationId,
			count: matching.length,
		})
		return {
			kind: 'revoked',
			action,
			installationId,
			details: { count: matching.length },
		}
	}

	return { kind: 'ignored', action, installationId }
}
