import { evictActor, evictMembership, revokeActorKeys } from '@maskin/auth'
import type { Transaction } from '@maskin/db'
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
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
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
	'conversation_participants',
	'conversation_pending_turns',
	'credential_access_log',
	'credential_chain_snapshots',
	'file_comments',
	'file_proposal_changes',
	'file_proposals',
	'files',
	'google_meet_space_idempotency',
	'live_activity_cards',
	'live_activity_tokens',
	'loop_active_days',
	'mcp_telemetry',
	'message_reactions',
	'message_thread_reads',
	'messages',
	'session_dispatch_attempts',
	'slack_user_links',
	'trigger_cooldowns',
	'trigger_dispatches',
	'trigger_event_queue',
	'user_display_settings',
	'voice_sessions',
	'workspace_invitations',
	'workspace_onboarding_prompts',
	'workspace_skills',
	'workspace_suppressions',
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
