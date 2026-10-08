import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { evictActor, evictApiKey, evictMembership, verifyPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	notifications,
	readState,
	slackUserLinks,
	starState,
	subscriptions,
	userDisplaySettings,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { accountDeletionPreviewSchema, deleteAccountSchema } from '@maskin/shared'
import { and, count, eq, inArray, ne } from 'drizzle-orm'
import { type MembershipFacts, accountDeletionPreview } from '../lib/account-deletion'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'

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
//   - It refuses while the person is the billing owner of a workspace other people use (transfer
//     ownership first) or of a workspace with a live plan (cancel it first).

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** What a deleted person is called everywhere their name still appears. */
export const DELETED_ACTOR_NAME = 'Deleted user'

async function loadMemberships(db: Database, actorId: string): Promise<MembershipFacts[]> {
	const mine = await db
		.select({
			workspaceId: workspaces.id,
			workspaceName: workspaces.name,
			billingOwnerId: workspaces.billingOwnerId,
			settings: workspaces.settings,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(eq(workspaceMembers.actorId, actorId))
	if (mine.length === 0) return []

	const others = await db
		.select({ workspaceId: workspaceMembers.workspaceId, n: count() })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				inArray(
					workspaceMembers.workspaceId,
					mine.map((m) => m.workspaceId),
				),
				eq(actors.type, 'human'),
				ne(workspaceMembers.actorId, actorId),
			),
		)
		.groupBy(workspaceMembers.workspaceId)
	const otherCount = new Map(others.map((o) => [o.workspaceId, Number(o.n)]))

	return mine.map((m) => {
		const settings = m.settings as { billing?: MembershipFacts['billing'] } | null
		const billing = settings?.billing
		return {
			workspaceId: m.workspaceId,
			workspaceName: m.workspaceName,
			billingOwnerId: m.billingOwnerId,
			otherHumanMembers: otherCount.get(m.workspaceId) ?? 0,
			billing: billing && typeof billing === 'object' ? billing : null,
		}
	})
}

// MARK: preview

const previewRoute = createRoute({
	method: 'get',
	path: '/deletion-preview',
	tags: ['Account'],
	summary: 'What deleting my account would do, and what stops it',
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
	const memberships = await loadMemberships(c.get('db'), c.get('actorId'))
	return c.json(accountDeletionPreview(c.get('actorId'), memberships), 200)
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
	const { password } = c.req.valid('json')

	const [actor] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	if (!actor || actor.type !== 'human' || !actor.passwordHash) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}
	if (!(await verifyPassword(password, actor.passwordHash))) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid credentials'), 401)
	}

	const result = await db.transaction(async (tx) => {
		// Lock the person's row so two deletions, or a deletion racing a transfer, can't interleave.
		const [locked] = await tx
			.select({ id: actors.id, apiKey: actors.apiKey })
			.from(actors)
			.where(eq(actors.id, actorId))
			.for('update')
			.limit(1)
		if (!locked) return { kind: 'gone' as const }

		// Decided inside the lock, from the same facts the preview shows.
		const memberships = await loadMemberships(tx as unknown as Database, actorId)
		const preview = accountDeletionPreview(actorId, memberships)
		if (!preview.can_delete) return { kind: 'blocked' as const, preview }

		for (const m of memberships) {
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
		await tx.delete(starState).where(eq(starState.actorId, actorId))
		await tx.delete(notifications).where(eq(notifications.targetActorId, actorId))
		await tx.delete(userDisplaySettings).where(eq(userDisplaySettings.actorId, actorId))
		await tx.delete(slackUserLinks).where(eq(slackUserLinks.actorId, actorId))

		// The row stays (records elsewhere reference it) but nothing about the person does. The key
		// is replaced with a random value nobody holds; null password and email mean no sign-in and
		// a free email.
		await tx
			.update(actors)
			.set({
				name: DELETED_ACTOR_NAME,
				email: null,
				passwordHash: null,
				apiKey: `deleted_${randomUUID().replaceAll('-', '')}`,
				description: null,
				systemPrompt: null,
				tools: null,
				memory: null,
				llmProvider: null,
				llmConfig: null,
				metadata: { deleted_at: new Date().toISOString() },
				updatedAt: new Date(),
			})
			.where(eq(actors.id, actorId))

		return {
			kind: 'deleted' as const,
			oldApiKey: locked.apiKey,
			workspaceIds: memberships.map((m) => m.workspaceId),
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
	evictApiKey(result.oldApiKey)
	evictActor(actorId)
	for (const workspaceId of result.workspaceIds) evictMembership(actorId, workspaceId)
	logger.info('account: deleted', { actorId, workspaces: result.workspaceIds.length })
	return c.json({ deleted: true as const }, 200)
})

export default app
