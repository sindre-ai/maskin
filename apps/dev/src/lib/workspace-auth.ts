import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Check if an actor is a member of a workspace.
 *
 * Workspace membership is enforced at two layers:
 * 1. authMiddleware — checks membership when the X-Workspace-Id header is present (list routes).
 * 2. This helper — checks membership on by-ID routes (GET/PATCH/DELETE /:id) where the workspace
 *    is derived from the resource itself, not the header. Both layers are intentional: the middleware
 *    guards header-scoped requests, while this helper guards resource-scoped requests.
 */
export async function isWorkspaceMember(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.actorId, actorId), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.limit(1)
	return !!member
}

/** Thrown when a viewer reaches a write route. app.onError turns the status into a 403. */
export class ViewerReadOnlyError extends Error {
	readonly status = 403
	constructor() {
		super('Viewers have read-only access to this workspace')
		this.name = 'ViewerReadOnlyError'
	}
}

/** The actor's role in a workspace, or null when they are not a member. */
export async function getWorkspaceRole(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<string | null> {
	const [member] = await db
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.actorId, actorId), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.limit(1)
	return member?.role ?? null
}

/**
 * isWorkspaceMember for write routes: false for a non-member (the caller keeps
 * its own 404), true for any role that may write, and a 403 for a viewer.
 * Reads keep using isWorkspaceMember, so viewers stay read-only, not locked out.
 */
export async function isWorkspaceWriter(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const role = await getWorkspaceRole(db, actorId, workspaceId)
	if (role === null) return false
	if (role === 'viewer') throw new ViewerReadOnlyError()
	return true
}

/**
 * Write check for routes scoped by the X-Workspace-Id header. authMiddleware
 * already looked the role up for the membership check and put it on the
 * context, so this costs no query. The role is undefined when no header was
 * sent, and by-ID routes use isWorkspaceWriter instead.
 */
export function assertWorkspaceWriterRole(role: string | undefined): void {
	if (role === 'viewer') throw new ViewerReadOnlyError()
}

/**
 * Write check for actor routes whose X-Workspace-Id header is optional. With the
 * header, the role authMiddleware put on the context decides. Without it, a
 * viewer could skip the gate by leaving the header off, so look at every
 * workspace the caller shares with the target (all of the caller's own when the
 * target is the caller): refuse when the caller is a viewer in each of them.
 * No shared workspace falls through, so the route keeps its own 404 or 403.
 */
export async function assertActorWriterAccess(
	db: Database,
	callerId: string,
	targetId: string,
	workspaceId: string | undefined,
	contextRole: string | undefined,
): Promise<void> {
	if (workspaceId) return assertWorkspaceWriterRole(contextRole)
	const roles = await db
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, callerId),
				sql`workspace_members.workspace_id in (select workspace_id from workspace_members where actor_id = ${targetId})`,
			),
		)
	if (roles.length > 0 && roles.every((r) => r.role === 'viewer')) throw new ViewerReadOnlyError()
}

/**
 * Whether `callerId` may reach `targetId` through a workspace they both belong
 * to: the caller itself, or two members of one workspace. When `workspaceId`
 * is given (the X-Workspace-Id header) the shared workspace must be that one.
 * By-ID actor routes use this so a member of workspace A cannot read or edit an
 * actor that only lives in workspace B.
 */
export async function actorsShareWorkspace(
	db: Database,
	callerId: string,
	targetId: string,
	workspaceId?: string,
): Promise<boolean> {
	if (callerId === targetId) return true
	if (workspaceId) {
		return (
			(await isWorkspaceMember(db, callerId, workspaceId)) &&
			(await isWorkspaceMember(db, targetId, workspaceId))
		)
	}
	const callerWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, callerId))
	if (callerWorkspaces.length === 0) return false
	const [shared] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, targetId),
				inArray(
					workspaceMembers.workspaceId,
					callerWorkspaces.map((w) => w.workspaceId),
				),
			),
		)
		.limit(1)
	return !!shared
}

/**
 * Whether `callerId` is an owner or admin (any actor type) of a workspace it
 * shares with `targetId`. When `workspaceId` (the X-Workspace-Id header) is
 * given, the role must be held in that workspace and the target must be a
 * member of it; otherwise any shared workspace counts. Gates writes to another
 * actor's tools and llm_config, which decide what runs in its sessions.
 * With `humanOnly`, an agent caller never passes, whatever its role.
 */
export async function isAdminOfSharedWorkspace(
	db: Database,
	callerId: string,
	targetId: string,
	workspaceId?: string,
	{ humanOnly = false }: { humanOnly?: boolean } = {},
): Promise<boolean> {
	if (humanOnly) {
		const [caller] = await db
			.select({ type: actors.type })
			.from(actors)
			.where(eq(actors.id, callerId))
			.limit(1)
		if (caller?.type !== 'human') return false
	}
	const callerAdminWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, callerId),
				inArray(workspaceMembers.role, ['owner', 'admin']),
				...(workspaceId ? [eq(workspaceMembers.workspaceId, workspaceId)] : []),
			),
		)
	if (callerAdminWorkspaces.length === 0) return false
	const [shared] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, targetId),
				inArray(
					workspaceMembers.workspaceId,
					callerAdminWorkspaces.map((w) => w.workspaceId),
				),
			),
		)
		.limit(1)
	return !!shared
}

export async function isWorkspaceOwner(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, actorId),
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.role, 'owner'),
			),
		)
		.limit(1)
	return !!member
}

// Human admin/owner check for surfaces where only workspace humans can act
// (e.g. the T5 "Verified by <human>" stamp on Knowledge Author writes).
// Agents must not pass — even if they somehow held an admin/owner membership,
// stamping is an object-level human verification, not an autonomous action.
export async function isWorkspaceHumanAdminOrOwner(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ role: workspaceMembers.role, type: actors.type })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(eq(workspaceMembers.actorId, actorId), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.limit(1)
	if (!row) return false
	if (row.type === 'agent') return false
	return row.role === 'owner' || row.role === 'admin'
}

/**
 * A human member who is not a viewer. For actions that need a person's
 * judgment, like accepting an agent's proposed change: viewers cannot write,
 * and agents with the member role must not decide on their own work. Not
 * isWorkspaceHumanAdminOrOwner, which would lock out regular members.
 * Reads the role through getWorkspaceRole, so a role change applies at once.
 */
export async function isWorkspaceHumanNonViewer(
	db: Database,
	actorId: string,
	workspaceId: string,
): Promise<boolean> {
	const role = await getWorkspaceRole(db, actorId, workspaceId)
	if (role === null || role === 'viewer') return false
	const [actor] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	return actor?.type === 'human'
}
