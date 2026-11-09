import type { Database } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	actors,
	integrations,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { count, eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { logger } from '../lib/logger'

const TICK_MS = 60 * 60 * 1000 // 1h
// Runs once a day, in the quiet hour after UTC midnight, so a redeploy during the
// day does not resend every workspace and person.
const RUN_AT_UTC_HOUR = 3
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Highest first. A role that is not listed ranks last.
const ROLE_RANK = ['owner', 'admin', 'member']

interface MemberRow {
	workspaceId: string
	actorId: string
	role: string
	type: string
	createdAt: Date | null
}

export interface AccountSyncSummary {
	workspaces: number
	people: number
}

function strongestRole(roles: string[]): string {
	const rank = (role: string) => {
		const i = ROLE_RANK.indexOf(role)
		return i === -1 ? ROLE_RANK.length : i
	}
	return [...roles].sort((a, b) => rank(a) - rank(b))[0] ?? 'member'
}

/**
 * Refreshes the PostHog account (workspace group) and person properties once a day.
 *
 * Group `workspace`: created_at, member_count (people), agent_count,
 * integrations_connected_count, has_outside_member, is_team.
 * Person: signup_date, workspace_role (the strongest role they hold), is_team.
 * Names, emails and message text are never sent.
 *
 * Privacy: a workspace's group goes through `capturePosthogEvent`, which drops it when
 * the workspace turned share-usage off. A person is only sent when none of their
 * workspaces turned sharing off or anonymises, because an anonymised workspace
 * identifies them under a hashed id and this job would otherwise create a second,
 * readable profile for the same person.
 *
 * "Team" is the workspace named by POSTHOG_TEAM_WORKSPACE_ID. Unset, nobody is the
 * team and has_outside_member is left off, since it would only restate "has a person".
 */
export class PosthogAccountSync {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private lastRunDay = ''

	constructor(private db: Database) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => void this.tick(), TICK_MS)
		this.timer.unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(now: Date = new Date()): Promise<AccountSyncSummary | null> {
		const day = now.toISOString().slice(0, 10)
		if (this.running || now.getUTCHours() !== RUN_AT_UTC_HOUR || this.lastRunDay === day) {
			return null
		}
		if (!process.env.POSTHOG_API_KEY?.trim()) return null
		this.running = true
		try {
			const summary = await this.syncAll()
			this.lastRunDay = day
			logger.info('PostHog account properties synced', { ...summary })
			return summary
		} catch (err) {
			logger.error('PostHog account sync failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return null
		} finally {
			this.running = false
		}
	}

	/** Reads every workspace and person once and sends their properties. */
	async syncAll(): Promise<AccountSyncSummary> {
		const teamWorkspaceId = process.env.POSTHOG_TEAM_WORKSPACE_ID?.trim() ?? ''
		const teamConfigured = UUID_RE.test(teamWorkspaceId)

		const workspaceRows = await this.db
			.select({ id: workspaces.id, createdAt: workspaces.createdAt, settings: workspaces.settings })
			.from(workspaces)
		const memberRows: MemberRow[] = await this.db
			.select({
				workspaceId: workspaceMembers.workspaceId,
				actorId: workspaceMembers.actorId,
				role: workspaceMembers.role,
				type: actors.type,
				createdAt: actors.createdAt,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		const integrationRows = await this.db
			.select({ workspaceId: integrations.workspaceId, total: count() })
			.from(integrations)
			.where(eq(integrations.status, INTEGRATION_STATUS_ACTIVE))
			.groupBy(integrations.workspaceId)
		const integrationsByWorkspace = new Map(
			integrationRows.map((r) => [r.workspaceId, Number(r.total)] as const),
		)

		const teamPeople = new Set(
			teamConfigured
				? memberRows
						.filter((m) => m.workspaceId === teamWorkspaceId && m.type === 'human')
						.map((m) => m.actorId)
				: [],
		)

		// Workspaces that keep a person out of the sync (sharing off, or anonymised).
		const privateWorkspaces = new Set<string>()
		for (const w of workspaceRows) {
			const privacy = (w.settings as { privacy?: Record<string, unknown> } | null)?.privacy
			if (privacy?.share_usage === false || privacy?.anonymize_workspace === true) {
				privateWorkspaces.add(w.id)
			}
		}

		const byWorkspace = new Map<string, MemberRow[]>()
		for (const m of memberRows) {
			const list = byWorkspace.get(m.workspaceId) ?? []
			list.push(m)
			byWorkspace.set(m.workspaceId, list)
		}

		let workspaceCount = 0
		for (const w of workspaceRows) {
			const members = byWorkspace.get(w.id) ?? []
			const people = members.filter((m) => m.type === 'human')
			const group: Record<string, string | number | boolean> = {
				workspace_id: w.id,
				member_count: people.length,
				agent_count: members.filter((m) => m.type === 'agent').length,
				integrations_connected_count: integrationsByWorkspace.get(w.id) ?? 0,
				is_team: teamConfigured && w.id === teamWorkspaceId,
			}
			if (w.createdAt) group.created_at = w.createdAt.toISOString()
			if (teamConfigured) group.has_outside_member = people.some((m) => !teamPeople.has(m.actorId))
			await capturePosthogEvent('$groupidentify', w.id, {
				workspace_id: w.id,
				$group_type: 'workspace',
				$group_key: w.id,
				$group_set: group,
			})
			workspaceCount++
		}

		const rolesByPerson = new Map<string, string[]>()
		const signupByPerson = new Map<string, Date | null>()
		const keptOut = new Set<string>()
		for (const m of memberRows) {
			if (m.type !== 'human') continue
			rolesByPerson.set(m.actorId, [...(rolesByPerson.get(m.actorId) ?? []), m.role])
			signupByPerson.set(m.actorId, m.createdAt)
			if (privateWorkspaces.has(m.workspaceId)) keptOut.add(m.actorId)
		}

		let peopleCount = 0
		for (const [actorId, roles] of rolesByPerson) {
			if (keptOut.has(actorId)) continue
			const set: Record<string, string | boolean> = {
				workspace_role: strongestRole(roles),
				is_team: teamPeople.has(actorId),
			}
			const signedUp = signupByPerson.get(actorId)
			if (signedUp) set.signup_date = signedUp.toISOString().slice(0, 10)
			await capturePosthogEvent('$set', actorId, { $set: set })
			peopleCount++
		}

		return { workspaces: workspaceCount, people: peopleCount }
	}
}
