import { evictActor, evictMembership, revokeActorKeys } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	agentChatGrants,
	agentFiles,
	agentGrants,
	agentSkills,
	awaitingVies,
	conversations,
	credentialAccessLog,
	credentialChainSnapshots,
	files,
	imports,
	installedLoops,
	integrations,
	linkedinActions,
	notifications,
	objects,
	orphanThreadDetections,
	readState,
	relationships,
	sessionLogs,
	sessions,
	starState,
	subscriptions,
	triggers,
	webhookDeliveries,
	workspaceCreditLedger,
	workspaceMembers,
	workspaceOverageUsage,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm'
import { TERMINAL_STATUSES } from '../services/session-lifecycle'
import { evictBillingUsage } from './billing-usage-cache'
import { logger } from './logger'

// Hard-deleting a workspace: removes every row that belongs to it, in one transaction, then (after
// commit) its files in object storage.
//
// Why this is explicit rather than "DELETE FROM workspaces and let the database cascade": 21 of
// the foreign keys that lead from `workspaces` are NO ACTION, and several tables hang off
// objects/sessions without a workspace column of their own (session_logs, relationships). A bare
// delete of the workspace row would fail on the first of them.
//
// Tables are handled one of three ways, and `WORKSPACE_PURGE_COVERAGE` records which, so the guard
// test (integration/workspace-deletion.test.ts) can fail when a new table that references
// workspaces is added without a decision:
//   - `explicit`: deleted below, in dependency order, because its FK is NO ACTION / RESTRICT or it
//     has no FK at all (webhook_deliveries.workspace_id, linkedin_actions.workspace_id, relationships).
//   - `cascade`:  has `ON DELETE CASCADE` towards a table that is deleted here, so the database
//     removes it (e.g. messages via conversations, file_comments via files).
//   - `set_null`: references a purged table with `ON DELETE SET NULL` and may belong to ANOTHER
//     workspace's data, so it is only unlinked.
//
// What is deliberately NOT deleted:
//   - Actor rows. Humans keep their account; the workspace only loses their membership. Agents are
//     created per workspace but the row can be referenced from other workspaces' history, so an
//     agent left with no membership anywhere is scrubbed (prompt, tools, memory, key) rather than
//     removed, the same treatment account deletion gives a person.
//   - marketplace_loops and its items: global catalog. installed_loops (this workspace's
//     installs) is deleted; the catalog entry stays.
//   - slack_user_links: the database cascades the row away when it names this workspace as the
//     person's default workspace. The person just re-links Slack; their account is untouched.
//   - idempotency_records / linkedin_tool_calls: keyed by actor, with a 24h TTL cleaner.
//
// The audit trail dies with the workspace (the events table is purged), so the deletion itself is
// recorded through the logger by the caller, not as an events row.

/** Tables the purge deletes by hand. The guard test requires every NO ACTION/RESTRICT child. */
export const WORKSPACE_PURGE_EXPLICIT = [
	'relationships',
	'webhook_deliveries',
	'linkedin_actions',
	'installed_loops',
	'session_logs',
	'notifications',
	'subscriptions',
	'read_state',
	'star_state',
	'workspace_credit_ledger',
	'workspace_overage_usage',
	'agent_chat_grants',
	'agent_grants',
	'credential_access_log',
	'credential_chain_snapshots',
	'done_when_lines',
	'done_when_skips',
	'orphan_thread_detections',
	'awaiting_vies',
	'agent_files',
	'imports',
	'integrations',
	'events',
	'sessions',
	'conversations',
	'triggers',
	'objects',
	'workspace_members',
] as const

/** Tables with ON DELETE CASCADE from a purged table; the database removes them. */
export const WORKSPACE_PURGE_CASCADE = [
	'agent_skills',
	'api_keys',
	'blocked_tool_calls',
	'comment_mentions',
	'comment_responder_claims',
	'conversation_participants',
	'conversation_pending_turns',
	'credential_access_log',
	'credential_chain_snapshots',
	'done_when_lines',
	'done_when_skips',
	'extensions',
	'file_comments',
	'file_proposal_changes',
	'file_proposals',
	'file_uploads',
	'files',
	'for_you_dismissals',
	'for_you_withdrawals',
	'google_meet_space_idempotency',
	'job_go_aheads',
	'job_outcomes',
	'live_activity_cards',
	'live_activity_follows',
	'live_activity_tokens',
	'loop_active_days',
	'mcp_telemetry',
	'message_reactions',
	'message_thread_reads',
	'messages',
	'next_step_sweep_claims',
	'next_steps',
	'oauth_authorization_codes',
	'oauth_grants',
	'oauth_tokens',
	'outcome_checks',
	'plan_limit_emails',
	'readings',
	'saved_views',
	'send_permissions',
	'session_dispatch_attempts',
	'slack_user_links',
	'trigger_cooldowns',
	'trigger_dispatches',
	'trigger_event_queue',
	'user_display_settings',
	'voice_sessions',
	'voice_tool_calls',
	'workspace_ai_usage',
	'workspace_invitations',
	'workspace_onboarding_prompts',
	'workspace_skills',
	'workspace_suppressions',
	'youtube_action_audit',
	'youtube_pending_actions',
] as const

export interface WorkspacePurgeResult {
	/** Object-storage keys recorded in rows that no longer exist. */
	storageKeys: string[]
	/** Everyone who was a member, so their cached membership can be evicted after commit. */
	memberActorIds: string[]
	/** Agents that were scrubbed, so their revoked keys leave the auth cache after commit. */
	scrubbedAgentIds: string[]
	/** Unfinished sessions that own a sandbox, to stop after commit. */
	liveSessions: LivePurgedSession[]
}

export interface LivePurgedSession {
	id: string
	workspaceId: string
	containerId: string | null
	agentServerId: string | null
}

const DELETED_AGENT_NAME = 'Deleted agent'

/** Rows per statement in `purgeWorkspaceInBatches`; small enough that cascades stay quick. */
const PURGE_BATCH_SIZE = 500

/**
 * Objects have the most cascades hanging off them, so each statement gets a smaller page than the
 * other tables: the app drops a query after 45 seconds, and that is what failed the Growth delete.
 */
const PURGE_OBJECTS_BATCH_SIZE = 100

export interface BatchedPurgeResult {
	/** Snapshot keys of the sessions deleted here, which the final purge can no longer read. */
	storageKeys: string[]
}

/**
 * Removes the bulky rows of a workspace in small statements, each its own short transaction, so
 * a workspace with hundreds of thousands of events, sessions and objects does not have to be
 * deleted by one long transaction (which ran past the query timeout and dropped the connection).
 * Call it before `purgeWorkspace`, which then finds little left and finishes the rest. It is safe
 * to run again after a failure: it only deletes what is still there.
 *
 * Unfinished sessions are left for `purgeWorkspace`, which reads their sandboxes before deleting.
 */
export async function purgeWorkspaceInBatches(
	db: Database,
	workspaceId: string,
	{ batchSize = PURGE_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<BatchedPurgeResult> {
	const storageKeys: string[] = []

	// installed_loops points at objects with NO ACTION, so it goes before them.
	await db.delete(installedLoops).where(eq(installedLoops.workspaceId, workspaceId))

	// Objects with the edges that touch them (edges have no foreign keys), a page at a time. The
	// edge delete is keyed by id, so it uses the source and target indexes.
	for (;;) {
		const page = await db
			.select({ id: objects.id })
			.from(objects)
			.where(eq(objects.workspaceId, workspaceId))
			.limit(Math.min(batchSize, PURGE_OBJECTS_BATCH_SIZE))
		if (page.length === 0) break
		const ids = page.map((r) => r.id)
		await db
			.delete(relationships)
			.where(or(inArray(relationships.sourceId, ids), inArray(relationships.targetId, ids)))
		await db.delete(objects).where(inArray(objects.id, ids))
	}

	// Logs of this workspace's sessions, then its events.
	for (;;) {
		const page = await db
			.select({ id: sessionLogs.id })
			.from(sessionLogs)
			.innerJoin(sessions, eq(sessions.id, sessionLogs.sessionId))
			.where(eq(sessions.workspaceId, workspaceId))
			.limit(batchSize * 4)
		if (page.length === 0) break
		await db.delete(sessionLogs).where(
			inArray(
				sessionLogs.id,
				page.map((r) => r.id),
			),
		)
	}
	for (;;) {
		const page = await db
			.select({ id: events.id })
			.from(events)
			.where(eq(events.workspaceId, workspaceId))
			.limit(batchSize * 4)
		if (page.length === 0) break
		await db.delete(events).where(
			inArray(
				events.id,
				page.map((r) => r.id),
			),
		)
	}

	// Finished sessions. They point at each other twice (retry_of, retried_session_id, both NO
	// ACTION, and the seed data shows a retry and its original pointing back at one another), so
	// no order is safe for a batch. Cut those links first; the sessions are going anyway.
	for (;;) {
		const linked = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					or(isNotNull(sessions.retryOf), isNotNull(sessions.retriedSessionId)),
				),
			)
			.limit(batchSize)
		if (linked.length === 0) break
		await db
			.update(sessions)
			.set({ retryOf: null, retriedSessionId: null })
			.where(
				inArray(
					sessions.id,
					linked.map((r) => r.id),
				),
			)
	}
	for (;;) {
		const page = await db
			.select({ id: sessions.id, snapshotPath: sessions.snapshotPath })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					inArray(sessions.status, [...TERMINAL_STATUSES]),
				),
			)
			.limit(batchSize)
		if (page.length === 0) break
		await db.delete(sessions).where(
			inArray(
				sessions.id,
				page.map((r) => r.id),
			),
		)
		for (const r of page) if (r.snapshotPath) storageKeys.push(r.snapshotPath)
	}

	return { storageKeys }
}

/**
 * Removes every row belonging to `workspaceId`. Runs inside the caller's transaction, which must
 * already hold a lock on the workspace row (`SELECT … FOR UPDATE`) so nothing is added mid-purge.
 */
export async function purgeWorkspace(
	tx: Transaction,
	workspaceId: string,
): Promise<WorkspacePurgeResult> {
	const wsObjects = tx
		.select({ id: objects.id })
		.from(objects)
		.where(eq(objects.workspaceId, workspaceId))
	const wsFiles = tx.select({ id: files.id }).from(files).where(eq(files.workspaceId, workspaceId))
	const wsSessions = tx
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.workspaceId, workspaceId))

	// Storage keys have to be read before the rows that hold them are gone.
	const storageKeys = new Set<string>()
	const add = (rows: { key: string | null }[]) => {
		for (const r of rows) if (r.key) storageKeys.add(r.key)
	}
	add(
		await tx
			.select({ key: files.storageKey })
			.from(files)
			.where(eq(files.workspaceId, workspaceId)),
	)
	add(
		await tx
			.select({ key: workspaceSkills.storageKey })
			.from(workspaceSkills)
			.where(eq(workspaceSkills.workspaceId, workspaceId)),
	)
	add(
		await tx
			.select({ key: agentFiles.storageKey })
			.from(agentFiles)
			.where(eq(agentFiles.workspaceId, workspaceId)),
	)
	add(
		await tx
			.select({ key: imports.fileStorageKey })
			.from(imports)
			.where(eq(imports.workspaceId, workspaceId)),
	)
	add(
		await tx
			.select({ key: sessions.snapshotPath })
			.from(sessions)
			.where(eq(sessions.workspaceId, workspaceId)),
	)

	// Unfinished sessions that own a sandbox. Read now: the rows are deleted below, and stopping
	// needs the container / agent-server id.
	const liveSessions = await tx
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			containerId: sessions.containerId,
			agentServerId: sessions.agentServerId,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				notInArray(sessions.status, [...TERMINAL_STATUSES]),
			),
		)

	const members = await tx
		.select({ actorId: workspaceMembers.actorId, type: actors.type })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(eq(workspaceMembers.workspaceId, workspaceId))

	// Edges have no foreign keys and join objects or files; an edge is the workspace's if either
	// end is one of its objects or files.
	await tx
		.delete(relationships)
		.where(
			or(
				inArray(relationships.sourceId, wsObjects),
				inArray(relationships.targetId, wsObjects),
				inArray(relationships.sourceId, wsFiles),
				inArray(relationships.targetId, wsFiles),
			),
		)
	await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, workspaceId))
	await tx.delete(linkedinActions).where(eq(linkedinActions.workspaceId, workspaceId))

	// installed_loops points at objects (NO ACTION), so it goes before them.
	await tx.delete(installedLoops).where(eq(installedLoops.workspaceId, workspaceId))

	// Tables that reference sessions/objects with NO ACTION, or by workspace, before those parents.
	await tx.delete(sessionLogs).where(inArray(sessionLogs.sessionId, wsSessions))
	await tx.delete(notifications).where(eq(notifications.workspaceId, workspaceId))
	await tx.delete(subscriptions).where(eq(subscriptions.workspaceId, workspaceId))
	await tx.delete(readState).where(eq(readState.workspaceId, workspaceId))
	await tx.delete(starState).where(eq(starState.workspaceId, workspaceId))
	await tx.delete(workspaceCreditLedger).where(eq(workspaceCreditLedger.workspaceId, workspaceId))
	await tx.delete(workspaceOverageUsage).where(eq(workspaceOverageUsage.workspaceId, workspaceId))
	await tx.delete(orphanThreadDetections).where(eq(orphanThreadDetections.workspaceId, workspaceId))
	// The audit trail dies with the workspace. The snapshot table is append-only by trigger; that
	// trigger lets a DELETE through only while this transaction-local flag is set (migration 0097).
	await tx.execute(sql`SELECT set_config('maskin.purging_workspace', 'on', true)`)
	await tx
		.delete(credentialChainSnapshots)
		.where(eq(credentialChainSnapshots.workspaceId, workspaceId))
	await tx.delete(credentialAccessLog).where(eq(credentialAccessLog.workspaceId, workspaceId))
	await tx.delete(agentChatGrants).where(eq(agentChatGrants.workspaceId, workspaceId))
	await tx.delete(agentGrants).where(eq(agentGrants.workspaceId, workspaceId))
	await tx.delete(awaitingVies).where(eq(awaitingVies.workspaceId, workspaceId))
	await tx.delete(agentFiles).where(eq(agentFiles.workspaceId, workspaceId))
	// Grants reference integrations/conversations (cascade) but also the workspace (NO ACTION).
	await tx.delete(agentGrants).where(eq(agentGrants.workspaceId, workspaceId))
	await tx.delete(agentChatGrants).where(eq(agentChatGrants.workspaceId, workspaceId))
	await tx.delete(imports).where(eq(imports.workspaceId, workspaceId))
	await tx.delete(integrations).where(eq(integrations.workspaceId, workspaceId))
	await tx.delete(events).where(eq(events.workspaceId, workspaceId))

	// One statement per table: sessions reference each other (retry_of), and NO ACTION is checked
	// at the end of the statement, so deleting them together is fine.
	await tx.delete(sessions).where(eq(sessions.workspaceId, workspaceId))
	await tx.delete(conversations).where(eq(conversations.workspaceId, workspaceId))
	await tx.delete(triggers).where(eq(triggers.workspaceId, workspaceId))
	await tx.delete(objects).where(eq(objects.workspaceId, workspaceId))
	await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))

	// Agents with no workspace left are scrubbed. Done after the memberships are gone so "no
	// membership anywhere" is a plain NOT IN over what remains.
	const agentIds = members.filter((m) => m.type === 'agent').map((m) => m.actorId)
	const scrubbedAgentIds: string[] = []
	if (agentIds.length > 0) {
		const stillMembers = tx
			.select({ id: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(inArray(workspaceMembers.actorId, agentIds))
		const orphaned = await tx
			.select({ id: actors.id })
			.from(actors)
			.where(and(inArray(actors.id, agentIds), notInArray(actors.id, stillMembers)))
		for (const a of orphaned) {
			scrubbedAgentIds.push(a.id)
			await revokeActorKeys(tx, a.id)
			await tx.delete(agentSkills).where(eq(agentSkills.actorId, a.id))
			await tx
				.update(actors)
				.set({
					name: DELETED_AGENT_NAME,
					apiKey: null,
					description: null,
					systemPrompt: null,
					tools: null,
					memory: null,
					llmProvider: null,
					llmConfig: null,
					metadata: { deleted_at: new Date().toISOString() },
					updatedAt: new Date(),
				})
				.where(eq(actors.id, a.id))
		}
	}

	// Everything else (invitations, files, skills, trigger children, display settings, the Keychain
	// audit trail, …) cascades.
	await tx.delete(workspaces).where(eq(workspaces.id, workspaceId))

	return {
		storageKeys: [...storageKeys],
		memberActorIds: members.map((m) => m.actorId),
		scrubbedAgentIds,
		liveSessions: liveSessions.filter((x) => x.containerId || x.agentServerId),
	}
}

export interface PurgeFailure {
	/** What goes in the log: the database's own words, never shown to the caller. */
	log: Record<string, unknown>
	/** What the caller is told. The transaction rolled back, so nothing was deleted. */
	message: string
}

/**
 * Reads a failed purge. The driver wraps the database error, so the SQLSTATE, table and
 * constraint sit on `cause`. The log gets all of it (the unexpected-error page used to hide it);
 * the caller gets a plain sentence, since a table name means nothing to them. `partial` is for a
 * failure in the batched step, which commits as it goes: some data may already be gone, and a
 * second try carries on from there.
 */
export function describePurgeFailure(err: unknown, { partial = false } = {}): PurgeFailure {
	const top = err instanceof Error ? err : undefined
	const cause = (top?.cause ?? err) as Record<string, unknown> | undefined
	const pick = (k: string) => (cause && typeof cause === 'object' ? cause[k] : undefined)
	const code = pick('code')
	const log = {
		code,
		table: pick('table_name'),
		constraint: pick('constraint_name'),
		detail: pick('detail'),
		message: cause instanceof Error ? cause.message : top?.message,
		query: typeof top?.message === 'string' ? top.message.slice(0, 300) : undefined,
	}
	const untouched = partial
		? 'Part of its data may already be removed, and trying again carries on from there.'
		: 'Nothing was deleted and the workspace is unchanged.'
	if (code === '23503') {
		return {
			log,
			message: `The workspace could not be deleted because some of its data is still linked to other data. ${untouched} Support has been given the details.`,
		}
	}
	if (
		code === '57014' ||
		code === '55P03' ||
		code === '40P01' ||
		top?.name === 'QueryTimeoutError'
	) {
		return {
			log,
			message: `The workspace could not be deleted because the database took too long or was busy. ${untouched} Try again in a minute.`,
		}
	}
	return {
		log,
		message: `The workspace could not be deleted because removing its data failed. ${untouched} Support has been given the details.`,
	}
}

/** Drops cached lookups so the workspace stops resolving immediately. Call after commit. */
export function evictPurgedWorkspace(workspaceId: string, result: WorkspacePurgeResult): void {
	for (const actorId of result.memberActorIds) evictMembership(actorId, workspaceId)
	for (const agentId of result.scrubbedAgentIds) evictActor(agentId)
	evictBillingUsage(workspaceId)
}

/**
 * Removes the workspace's objects from storage. Runs after commit and never throws: the rows are
 * already gone, so a storage failure leaves unreachable bytes, not a half-deleted workspace.
 * Failures are logged with the key so they can be swept.
 */
export async function purgeWorkspaceStorage(
	storage: StorageProvider | undefined,
	workspaceId: string,
	result: WorkspacePurgeResult,
): Promise<void> {
	if (!storage) return
	const keys = new Set(result.storageKeys)
	for (const prefix of [`agents/${workspaceId}/`, `workspaces/${workspaceId}/`]) {
		try {
			for (const key of await storage.list(prefix)) keys.add(key)
		} catch (err) {
			logger.error('workspace purge: listing storage failed', { workspaceId, prefix, err })
		}
	}
	let failed = 0
	for (const key of keys) {
		try {
			await storage.delete(key)
		} catch (err) {
			failed++
			logger.error('workspace purge: storage delete failed', { workspaceId, key, err })
		}
	}
	logger.info('workspace purge: storage cleared', { workspaceId, objects: keys.size, failed })
}

/**
 * Stops the sandboxes of the purged workspace's unfinished sessions. Runs after commit and never
 * throws, like the storage purge: the rows are already gone.
 */
export async function stopPurgedSessions(
	stopper: { stopSandboxesForPurge(rows: LivePurgedSession[]): Promise<void> } | undefined,
	result: WorkspacePurgeResult,
): Promise<void> {
	if (!stopper || result.liveSessions.length === 0) return
	try {
		await stopper.stopSandboxesForPurge(result.liveSessions)
	} catch (err) {
		logger.error('workspace purge: stopping sessions failed', { err })
	}
}
