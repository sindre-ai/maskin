import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

// Who may reach WHICH agent's desktop. Every agent has its own computer, and
// what is logged in on it (a bookkeeping account, say) belongs to that agent
// alone — so this is the one place the rule lives, and every route and the
// stream relay call it before they touch a desktop:
//
//   • An AGENT may reach only its own desktop. Naming another agent is refused,
//     not silently redirected: an agent that asks for a colleague's screen is a
//     bug or an attack, and either way should hear "no".
//   • A HUMAN may reach the desktop of any agent in a workspace they belong to
//     (to watch it, take over, or teach it). They must say which agent.
//
// Workspace membership of the caller is already enforced by authMiddleware for
// header-scoped routes; the stream relay re-checks it separately at upgrade time.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type DesktopAccess =
	| { ok: true; agentId: string }
	| { ok: false; status: 400 | 403 | 404; message: string }

export type DesktopCaller = {
	actorId: string
	actorType: string | undefined
	workspaceId: string
	// The agent the caller named (`?agent_id=`), if any.
	requestedAgentId: string | undefined
}

/** True when `agentId` is an agent actor that is a member of the workspace. */
async function isAgentInWorkspace(
	db: Database,
	workspaceId: string,
	agentId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(actors.id, agentId),
				eq(actors.type, 'agent'),
				eq(workspaceMembers.workspaceId, workspaceId),
			),
		)
		.limit(1)
	return !!row
}

export async function resolveDesktopAgent(
	db: Database,
	caller: DesktopCaller,
): Promise<DesktopAccess> {
	const requested = caller.requestedAgentId?.toLowerCase()
	if (requested !== undefined && !UUID_RE.test(requested)) {
		return { ok: false, status: 400, message: 'agent_id must be a UUID' }
	}

	if (caller.actorType === 'agent') {
		if (requested !== undefined && requested !== caller.actorId.toLowerCase()) {
			return { ok: false, status: 403, message: 'An agent can only use its own computer' }
		}
		return { ok: true, agentId: caller.actorId.toLowerCase() }
	}

	if (requested === undefined) {
		return { ok: false, status: 400, message: 'agent_id is required: whose computer is this?' }
	}
	if (!(await isAgentInWorkspace(db, caller.workspaceId, requested))) {
		return { ok: false, status: 404, message: 'Agent not found in this workspace' }
	}
	return { ok: true, agentId: requested }
}

/**
 * The stream relay's check, made at upgrade time from the ticket's claims: the
 * actor must still be allowed to reach that agent's desktop right now (agent:
 * itself; human: a workspace member and the agent still in the workspace).
 */
export async function canAccessDesktop(
	db: Database,
	actorId: string,
	workspaceId: string,
	agentId: string,
): Promise<boolean> {
	const [actor] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (!actor) return false
	const access = await resolveDesktopAgent(db, {
		actorId,
		actorType: actor.type,
		workspaceId,
		requestedAgentId: agentId,
	})
	return access.ok && access.agentId === agentId.toLowerCase()
}
