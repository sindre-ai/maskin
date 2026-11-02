import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import {
	evictActor,
	evictApiKeyHash,
	evictMembership,
	revokeActorKeys,
	verifyPassword,
} from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	apiKeys,
	deviceAuthCodes,
	deviceTokens,
	forYouDismissals,
	liveActivityCards,
	liveActivityTokens,
	notificationPreferences,
	notifications,
	readState,
	slackUserLinks,
	starState,
	subscriptions,
	userDisplaySettings,
	webPushSubscriptions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { accountDeletionPreviewSchema, deleteAccountSchema } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { accountDeletionPreview, isSoleHuman } from '../lib/account-deletion'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { loadMembershipFacts } from '../lib/membership-facts'
import { errorSchema } from '../lib/openapi-schemas'
import { lockActorForOwnershipClaim } from '../lib/workspace-capacity'
import {
	type WorkspacePurgeResult,
	evictPurgedWorkspace,
	purgeWorkspace,
	purgeWorkspaceStorage,
	stopPurgedSessions,
} from '../lib/workspace-purge'
import type { SessionManager } from '../services/session-manager'

// Deleting your own account (App Store guideline 5.1.1(v): an app that offers sign-up must let the
// person delete the account from inside the app).
//
// What deletion does, and does not do:
//   - It ERASES the person: name, email, password and API key are overwritten, so the account can
//     no longer sign in, the email is free to register again, and nothing identifies them.
//   - It removes their memberships, read/star/subscription state, inbox and display settings.
//   - It does NOT delete what they wrote or created. Objects, comments, messages and files belong
//     to the workspaces they were made in; they stay, attributed to "Deleted user". Rewriting other
//     people's workspaces is not ours to do, and the actor row is what keeps those records intact.
//   - Opt-in (`delete_sole_workspaces`): every workspace the person is the only human in is
//     erased with them, content and all, via `purgeWorkspace`. Without the flag those stay.
//   - It refuses while the person is the billing owner of a workspace other people use (transfer
//     ownership first) or of a workspace with a live plan (cancel it first).

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		storageProvider?: StorageProvider
		sessionManager?: SessionManager
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** What a deleted person is called everywhere their name still appears. */
export const DELETED_ACTOR_NAME = 'Deleted user'

// MARK: preview

const previewRoute = createRoute({
	method: 'get',
	path: '/deletion-preview',
	tags: ['Account'],
	summary: 'What deleting my account would do, and what stops it',
	request: {
		query: z.object({
			// Same flag the delete request carries, so the blockers match what that request would decide.
			delete_sole_workspaces: z
				.enum(['true', 'false'])
				.optional()
				.transform((v) => v === 'true'),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: accountDeletionPreviewSchema } },
			description: 'The workspaces you would leave and anything blocking deletion',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a person' },
	},
})

app.openapi(previewRoute, async (c) => {
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person has an account to delete'), 403)
	}
	const { delete_sole_workspaces: deleteSoleWorkspaces } = c.req.valid('query')
	const memberships = await loadMembershipFacts(c.get('db'), c.get('actorId'))
	return c.json(
		accountDeletionPreview(c.get('actorId'), memberships, { deleteSoleWorkspaces }),
		200,
	)
})

// MARK: delete

const deleteRoute = createRoute({
	method: 'post',
	path: '/delete',
	tags: ['Account'],
	summary: 'Delete my account',
	description:
		'Erases the signed-in person (name, email, password, API key) and removes their memberships and personal data. What they wrote stays in its workspace, attributed to "Deleted user". Requires the password again. Refused with 409 while you are the billing owner of a workspace others use or of a workspace with a live plan.',
	request: {
		body: { content: { 'application/json': { schema: deleteAccountSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } },
			description: 'Account deleted',
		},
		401: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Wrong password',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a person' },
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Blocked: transfer ownership or cancel the plan first',
		},
	},
})

app.openapi(deleteRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a person has an account to delete'), 403)
	}
	const { password, delete_sole_workspaces: deleteSoleWorkspaces } = c.req.valid('json')

	const [actor] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	if (!actor || actor.type !== 'human' || !actor.passwordHash) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}
	if (!(await verifyPassword(password, actor.passwordHash))) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}

	const result = await db.transaction(async (tx) => {
		// Same advisory lock transfer-ownership takes on the NEW owner before it reads their
		// membership. Without it a transfer that already read this person as a member could commit
		// after the memberships are deleted below, leaving the workspace billed to an erased account
		// that nobody can transfer away from. With it, a transfer either lands first (and this
		// request is then refused with 409) or finds no membership (404).
		await lockActorForOwnershipClaim(tx, actorId)
		// Lock the person's row so two deletions, or a deletion racing a transfer, can't interleave.
		const [locked] = await tx
			.select({ id: actors.id })
			.from(actors)
			.where(eq(actors.id, actorId))
			.for('update')
			.limit(1)
		if (!locked) return { kind: 'gone' as const }

		// Workspaces about to be erased are locked too, so nobody can be added to one between the
		// "only human" check and the purge.
		if (deleteSoleWorkspaces) {
			await tx
				.select({ id: workspaces.id })
				.from(workspaceMembers)
				.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
				.where(eq(workspaceMembers.actorId, actorId))
				.orderBy(workspaces.id)
				.for('update', { of: workspaces })
		}

		// Decided inside the lock, from the same facts the preview shows.
		const memberships = await loadMembershipFacts(tx as unknown as Database, actorId)
		const preview = accountDeletionPreview(actorId, memberships, { deleteSoleWorkspaces })
		if (!preview.can_delete) return { kind: 'blocked' as const, preview }

		const purged: { workspaceId: string; result: WorkspacePurgeResult }[] = []
		if (deleteSoleWorkspaces) {
			for (const m of memberships.filter(isSoleHuman)) {
				purged.push({ workspaceId: m.workspaceId, result: await purgeWorkspace(tx, m.workspaceId) })
			}
		}
		const purgedIds = new Set(purged.map((p) => p.workspaceId))

		for (const m of memberships) {
			// A purged workspace takes its audit trail with it; its deletion is logged after commit.
			if (purgedIds.has(m.workspaceId)) continue
			await recordEvent(tx, {
				workspaceId: m.workspaceId,
				actorId,
				action: 'deleted',
				entityType: 'workspace_member',
				entityId: actorId,
				data: { removed_actor_id: actorId, self_removal: true, account_deleted: true },
			})
		}
		await tx.delete(workspaceMembers).where(eq(workspaceMembers.actorId, actorId))
		await tx.delete(subscriptions).where(eq(subscriptions.actorId, actorId))
		await tx.delete(readState).where(eq(readState.actorId, actorId))
		await tx.delete(forYouDismissals).where(eq(forYouDismissals.actorId, actorId))
		await tx.delete(starState).where(eq(starState.actorId, actorId))
		await tx.delete(notifications).where(eq(notifications.targetActorId, actorId))
		// Personal data (timezone, quiet hours, briefing state); the actor row stays, so its cascade never fires.
		await tx.delete(notificationPreferences).where(eq(notificationPreferences.actorId, actorId))
		await tx.delete(userDisplaySettings).where(eq(userDisplaySettings.actorId, actorId))
		await tx.delete(slackUserLinks).where(eq(slackUserLinks.actorId, actorId))
		// The actor row is kept, so its ON DELETE CASCADE never fires. These hold APNs tokens and
		// device sign-ins of the person: left behind, a Live Activity or push could still reach their
		// phone. Tokens go before devices so nothing depends on the device cascade.
		await tx.delete(liveActivityTokens).where(eq(liveActivityTokens.actorId, actorId))
		await tx.delete(liveActivityCards).where(eq(liveActivityCards.actorId, actorId))
		await tx.delete(deviceTokens).where(eq(deviceTokens.actorId, actorId))
		await tx.delete(deviceAuthCodes).where(eq(deviceAuthCodes.actorId, actorId))
		// Browser push subscriptions are endpoint URLs plus keys that can reach the person's browser.
		await tx.delete(webPushSubscriptions).where(eq(webPushSubscriptions.actorId, actorId))

		// The row stays (records elsewhere reference it) but nothing about the person does. Every
		// key is revoked, then its hash row erased, and the legacy plaintext column is cleared; null
		// password and email mean no sign-in and a free email.
		const revokedKeyHashes = await revokeActorKeys(tx, actorId)
		await tx.delete(apiKeys).where(eq(apiKeys.actorId, actorId))
		await tx
			.update(actors)
			.set({
				name: DELETED_ACTOR_NAME,
				email: null,
				passwordHash: null,
				apiKey: null,
				description: null,
				systemPrompt: null,
				tools: null,
				memory: null,
				llmProvider: null,
				llmConfig: null,
				defaultWorkspaceId: null,
				metadata: { deleted_at: new Date().toISOString() },
				updatedAt: new Date(),
			})
			.where(eq(actors.id, actorId))

		return {
			kind: 'deleted' as const,
			revokedKeyHashes,
			workspaceIds: memberships.map((m) => m.workspaceId).filter((id) => !purgedIds.has(id)),
			purged,
		}
	})

	if (result.kind === 'gone') {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}
	if (result.kind === 'blocked') {
		const first = result.preview.blockers[0]
		const message =
			first?.code === 'transfer_ownership'
				? `Transfer ownership of "${first.workspace_name}" to another member first.`
				: `Cancel the plan on "${first?.workspace_name}" first.`
		return c.json(createApiError('CONFLICT', message), 409)
	}

	// Takes effect on the very next request, not when the cached lookups expire.
	evictActor(actorId)
	// The eviction inside the transaction can be undone by a request that lands before the commit.
	for (const keyHash of result.revokedKeyHashes) evictApiKeyHash(keyHash)
	for (const workspaceId of result.workspaceIds) evictMembership(actorId, workspaceId)
	for (const p of result.purged) {
		evictPurgedWorkspace(p.workspaceId, p.result)
		logger.info('account: workspace deleted with account', { actorId, workspaceId: p.workspaceId })
		await stopPurgedSessions(c.get('sessionManager'), p.result)
		await purgeWorkspaceStorage(c.get('storageProvider'), p.workspaceId, p.result)
	}
	logger.info('account: deleted', {
		actorId,
		workspaces: result.workspaceIds.length,
		deletedWorkspaces: result.purged.length,
	})
	return c.json({ deleted: true as const }, 200)
})

export default app
