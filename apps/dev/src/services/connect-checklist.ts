import type { Database } from '@maskin/db'
import { actors, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { trackConnectChecklistStarted } from '../lib/analytics/integration-events'
import { findChiefOfStaffId } from '../lib/chief-of-staff'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import { shouldSkipOnboardingKickoff } from '../lib/onboarding/chief-of-staff-kickoff'
import { startSession } from './session-lifecycle'

/** Name of the skill the Chief of Staff runs when a tool is connected. */
export const CONNECT_CHECKLIST_SKILL = 'integration-connect-checklist'

type DefaultAgentAccess = 'read' | 'read_write' | 'none'

const ACCESS_WORDS: Record<DefaultAgentAccess, string> = {
	read: 'read',
	read_write: 'read and write',
	none: 'none yet (a person has not given agents access)',
}

export function buildConnectChecklistPrompt(input: {
	person: string
	tool: string
	access: DefaultAgentAccess
}): string {
	return `${input.person} just connected ${input.tool} to this workspace. Agent access to it: ${ACCESS_WORDS[input.access]}. Run your \`${CONNECT_CHECKLIST_SKILL}\` skill now.`
}

function toolName(provider: string): string {
	try {
		return getProvider(provider).config.displayName
	} catch {
		return provider
	}
}

/**
 * Starts the workspace's Chief of Staff on its connect checklist after a person connects a tool
 * through a registered sign-in. Call it only for a new connect (never a refreshed login), at the
 * same place as the integration_connected event. Fire-and-forget like startChiefOfStaffWelcome:
 * the session is not awaited, and every failure is logged, never thrown, because the connect
 * itself has already worked.
 */
export async function startConnectChecklistSession(
	input: {
		db: Database
		workspaceId: string
		actorId: string
		integrationId: string
		provider: string
	},
	deps: { start?: typeof startSession } = {},
): Promise<{ started: boolean }> {
	const { db, workspaceId, actorId, integrationId, provider } = input
	const start = deps.start ?? startSession
	try {
		if (shouldSkipOnboardingKickoff()) return { started: false }

		const chiefOfStaffId = await findChiefOfStaffId(db, workspaceId)
		if (!chiefOfStaffId) {
			logger.info('Connect checklist not started: workspace has no Chief of Staff', {
				workspaceId,
				provider,
			})
			return { started: false }
		}

		const [person] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)
		const [row] = await db
			.select({ access: integrations.defaultAgentAccess })
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.limit(1)

		await start({
			workspaceId,
			actorId: chiefOfStaffId,
			callerKind: 'internal',
			actionPrompt: buildConnectChecklistPrompt({
				person: person?.name ?? 'A person',
				tool: toolName(provider),
				access: row?.access ?? 'none',
			}),
			createdBy: actorId,
			initiatedFromObjectId: null,
			await: 'none',
		})
		// Provider and workspace only, never text.
		void trackConnectChecklistStarted({ provider, workspaceId })
		return { started: true }
	} catch (err) {
		logger.warn('Connect checklist session did not start', {
			workspaceId,
			provider,
			integrationId,
			error: String(err),
		})
		return { started: false }
	}
}
