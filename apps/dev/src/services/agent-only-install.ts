import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { shouldSkipOnboardingKickoff } from '../lib/onboarding/chief-of-staff-kickoff'
import { introduceAgentToRecipient } from './agent-intro'
import { createIntroScanRunner } from './agent-intro-scan'
import { findOrCreateDirectChat } from './direct-chat'
import type { SessionManager } from './session-manager'

/**
 * After an agent-only listing has installed: the new agent says hello to the person who
 * installed it, in their direct message. Returns that chat's id so the install reply can
 * open it, or null when the installer is an agent (the hello then goes to the person
 * behind its session, whose chat the caller cannot know yet).
 *
 * The hello itself is fire and forget and never throws (see introduceAgentToRecipient): a
 * workspace with no model key gets the connect-a-key hello, and the install is not affected.
 * The direct message is opened here first, and the hello reuses it, so the id returned is
 * the chat the hello lands in.
 */
export async function greetInstalledAgent(args: {
	db: Database
	sessionManager: SessionManager | undefined
	workspaceId: string
	installerId: string
	agentId: string
	firstLook: string | null
	claimedSessionId: string | undefined
	clientSource: string | undefined
}): Promise<{ chatId: string | null }> {
	const { db, workspaceId, installerId, agentId } = args
	const [[agent], [installer]] = await Promise.all([
		db.select().from(actors).where(eq(actors.id, agentId)).limit(1),
		db.select({ type: actors.type }).from(actors).where(eq(actors.id, installerId)).limit(1),
	])
	if (!agent || !installer) return { chatId: null }

	const chatId =
		installer.type === 'human'
			? (
					await findOrCreateDirectChat(db, {
						workspaceId,
						humanId: installerId,
						agentId,
						title: agent.name,
						createdBy: installerId,
					})
				).id
			: null

	void introduceAgentToRecipient({
		db,
		actor: agent,
		workspaceId,
		creator: { id: installerId, type: installer.type },
		claimedSessionId: args.claimedSessionId,
		clientSource: args.clientSource,
		// The agent looks around before suggesting first steps. Not in an E2E stack, where
		// every workspace lacks credentials and the session would only churn.
		scan:
			args.sessionManager && !shouldSkipOnboardingKickoff()
				? createIntroScanRunner({ db, sessionManager: args.sessionManager })
				: undefined,
		firstLook: args.firstLook ?? undefined,
	})
	return { chatId }
}
