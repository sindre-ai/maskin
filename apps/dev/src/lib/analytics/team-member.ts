import type { Database } from '@maskin/db'
import { workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Membership changes rarely, so a long window is safe; the cap bounds memory.
const TEAM_CACHE_TTL_MS = 10 * 60_000
const TEAM_CACHE_CAP = 2_000

type TeamMemberReader = (teamWorkspaceId: string, actorId: string) => Promise<boolean>
type TeamMemberEntry = { expiresAt: number; value: Promise<boolean> }

let readTeamMember: TeamMemberReader | null = null
const teamMemberCache = new Map<string, TeamMemberEntry>()

/** Wires the team membership lookup to the database. Called once at startup. */
export function configureTeamMember(db: Database): void {
	teamMemberCache.clear()
	readTeamMember = async (teamWorkspaceId, actorId) => {
		const [row] = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, teamWorkspaceId),
					eq(workspaceMembers.actorId, actorId),
				),
			)
			.limit(1)
		return Boolean(row)
	}
}

/** Test-only: drops the lookup and its cache. */
export function __resetTeamMemberForTesting(): void {
	readTeamMember = null
	teamMemberCache.clear()
}

/**
 * Whether an actor is on our own team: a human member of the workspace named by
 * POSTHOG_TEAM_WORKSPACE_ID. Unset or malformed means nobody is the team, and an
 * unreadable membership counts as not the team, so a customer is never marked as
 * us. Agents are never the team: they are told apart by actor_type.
 */
export async function isTeamActor(actorId: string, actorType: string): Promise<boolean> {
	if (actorType !== 'human') return false
	const teamWorkspaceId = process.env.POSTHOG_TEAM_WORKSPACE_ID?.trim()
	const reader = readTeamMember
	if (!teamWorkspaceId || !reader) return false
	if (!UUID_RE.test(teamWorkspaceId) || !UUID_RE.test(actorId)) return false
	const key = `${teamWorkspaceId}:${actorId}`
	const now = Date.now()
	let entry = teamMemberCache.get(key)
	if (!entry || entry.expiresAt <= now) {
		const created: TeamMemberEntry = {
			expiresAt: now + TEAM_CACHE_TTL_MS,
			value: reader(teamWorkspaceId, actorId),
		}
		entry = created
		teamMemberCache.set(key, created)
		// A failed read must not be served for the rest of the window.
		created.value.catch(() => {
			if (teamMemberCache.get(key) === created) teamMemberCache.delete(key)
		})
		if (teamMemberCache.size > TEAM_CACHE_CAP) {
			for (const [k, e] of teamMemberCache) {
				if (e.expiresAt <= now) teamMemberCache.delete(k)
			}
		}
	}
	try {
		return await entry.value
	} catch {
		return false
	}
}

/**
 * Whether a workspace is one of ours: the workspace named by
 * POSTHOG_TEAM_WORKSPACE_ID. Unset or malformed means none is, so a customer's
 * workspace is never marked as ours. Plain comparison, no database read.
 */
export function isInternalWorkspace(workspaceId: string | undefined | null): boolean {
	const teamWorkspaceId = process.env.POSTHOG_TEAM_WORKSPACE_ID?.trim()
	if (!teamWorkspaceId || !workspaceId) return false
	if (!UUID_RE.test(teamWorkspaceId)) return false
	return teamWorkspaceId.toLowerCase() === workspaceId.toLowerCase()
}
