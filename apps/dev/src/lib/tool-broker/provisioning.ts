import {
	events,
	type Database,
	actors,
	toolBrokerActors,
	workspaceToolBrokers,
	workspaces,
} from '@maskin/db'
import { ToolBrokerClient, workspaceScopedSlug } from '@maskin/tool-broker'
import { and, eq, isNull } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto'
import { logger } from '../logger'

// ---------------------------------------------------------------------------
// Provisioning for the tool broker.
//
// Two things get provisioned lazily, on first use, and both are idempotent
// because a session launch and a settings-page click can race:
//
//   - ONE TOOLKIT PER WORKSPACE. The workspace's tool surface. Its membership
//     admits only that workspace's own integrations, so a fresh toolkit reaches
//     nothing until an integration is connected.
//
//   - ONE BROKER IDENTITY PER ACTOR. The backend has no organisation-level key
//     and no impersonation, so per-user credential isolation is only available
//     if each actor has its own identity. The API key is encrypted at rest; the
//     password used to mint it is generated inside the client, used once and
//     discarded.
//
// `TOOL_BROKER_URL` unset means the feature does not exist: `getToolBrokerClient`
// returns null and every caller degrades rather than failing.
// ---------------------------------------------------------------------------

/** The configured client, or null when the feature is not configured at all. */
export const getToolBrokerClient = (): ToolBrokerClient | null => {
	const baseUrl = process.env.TOOL_BROKER_URL
	const adminEmail = process.env.TOOL_BROKER_ADMIN_EMAIL
	const adminPassword = process.env.TOOL_BROKER_ADMIN_PASSWORD
	if (!baseUrl || !adminEmail || !adminPassword) return null
	return new ToolBrokerClient({ baseUrl, adminEmail, adminPassword })
}

export interface ProvisionedWorkspace {
	/** The `workspace_tool_brokers` row id — a real uuid, usable as an events entityId. */
	readonly rowId: string
	readonly toolkitId: string
	readonly toolkitSlug: string
}

/**
 * Ensure the workspace has a toolkit, returning the row either way.
 *
 * The insert uses `onConflictDoNothing` and re-reads rather than trusting its
 * own return: under a race the loser inserts nothing, and the winner's row is
 * the one both callers must agree on. The unique index on `workspace_id` is
 * what makes that safe — see the integration test.
 */
export const ensureWorkspaceToolkit = async (
	db: Database,
	client: ToolBrokerClient,
	input: { workspaceId: string; actorId: string; apiKey: string },
): Promise<ProvisionedWorkspace> => {
	const existing = await db
		.select()
		.from(workspaceToolBrokers)
		// The workspace DEFAULT row specifically. Agents can now have their own
		// rows in this table, so a bare workspace_id match would sometimes return
		// an agent's toolkit and quietly widen or narrow the wrong one.
		.where(
			and(
				eq(workspaceToolBrokers.workspaceId, input.workspaceId),
				isNull(workspaceToolBrokers.actorId),
			),
		)
		.limit(1)
	if (existing[0]) {
		return {
			rowId: existing[0].id,
			toolkitId: existing[0].toolkitId,
			toolkitSlug: existing[0].toolkitSlug,
		}
	}

	const [workspace] = await db
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, input.workspaceId))
		.limit(1)

	const toolkit = await client.ensureToolkit(input.apiKey, {
		workspaceId: input.workspaceId,
		name: workspace?.name ?? 'Workspace',
	})

	await db
		.insert(workspaceToolBrokers)
		.values({
			workspaceId: input.workspaceId,
			toolkitSlug: toolkit.slug,
			toolkitId: toolkit.id,
		})
		.onConflictDoNothing()

	// Re-read: under a race this returns the winner's row, not ours.
	const [row] = await db
		.select()
		.from(workspaceToolBrokers)
		// The workspace DEFAULT row specifically. Agents can now have their own
		// rows in this table, so a bare workspace_id match would sometimes return
		// an agent's toolkit and quietly widen or narrow the wrong one.
		.where(
			and(
				eq(workspaceToolBrokers.workspaceId, input.workspaceId),
				isNull(workspaceToolBrokers.actorId),
			),
		)
		.limit(1)
	if (!row) throw new Error('Failed to provision a tool broker toolkit for this workspace')

	await db.insert(events).values({
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		action: 'created',
		entityType: 'workspace_tool_broker',
		entityId: row.id,
		data: { toolkitSlug: row.toolkitSlug },
	})

	return { rowId: row.id, toolkitId: row.toolkitId, toolkitSlug: row.toolkitSlug }
}

/**
 * Ensure the actor has a broker identity, returning its DECRYPTED api key.
 *
 * The key is returned in plaintext because every caller immediately spends it on
 * a request; it is never written back anywhere in that form. The backend hands a
 * key over exactly once, so a duplicate identity would strand the first one —
 * hence the unique index on `actor_id` and the re-read after the conflict.
 */
export const ensureActorIdentity = async (
	db: Database,
	client: ToolBrokerClient,
	actorId: string,
): Promise<string> => {
	const [existing] = await db
		.select()
		.from(toolBrokerActors)
		.where(eq(toolBrokerActors.actorId, actorId))
		.limit(1)
	if (existing) return decrypt(existing.apiKey)

	const [actor] = await db
		.select({ name: actors.name, email: actors.email })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)

	// The email only has to be unique and stable on the backend; the actor's own
	// address is not reused, so a Maskin email change cannot orphan the identity.
	const provisioned = await client.provisionActor({
		email: `actor-${actorId}@tool-broker.local`,
		displayName: actor?.name ?? 'Maskin agent',
	})

	await db
		.insert(toolBrokerActors)
		.values({
			actorId,
			subjectId: provisioned.subjectId,
			apiKey: encrypt(provisioned.apiKey),
		})
		.onConflictDoNothing()

	const [row] = await db
		.select()
		.from(toolBrokerActors)
		.where(eq(toolBrokerActors.actorId, actorId))
		.limit(1)
	if (!row) throw new Error('Failed to provision a tool broker identity for this actor')

	// A race means the other caller's key won and ours is now unreachable — the
	// backend will not hand it over again. Worth a warning: it is a leaked
	// identity on the backend, harmless but untracked.
	if (row.subjectId !== provisioned.subjectId) {
		logger.warn('Discarded a duplicate tool broker identity after a provisioning race', {
			actorId,
			keptSubjectId: row.subjectId,
		})
	}

	return decrypt(row.apiKey)
}

/** Both halves at once — what every route and the session launcher needs. */
export const ensureProvisioned = async (
	db: Database,
	input: { workspaceId: string; actorId: string },
): Promise<{ client: ToolBrokerClient; apiKey: string; toolkit: ProvisionedWorkspace } | null> => {
	const client = getToolBrokerClient()
	if (!client) return null

	const apiKey = await ensureActorIdentity(db, client, input.actorId)
	const toolkit = await ensureWorkspaceToolkit(db, client, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		apiKey,
	})
	return { client, apiKey, toolkit }
}

/** Namespaced slug for a user-supplied integration name. Re-exported for routes. */
export const scopedSlug = workspaceScopedSlug
