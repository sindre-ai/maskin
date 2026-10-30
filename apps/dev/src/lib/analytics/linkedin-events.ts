import { capturePosthogEvent } from './posthog'

// One generic event per call to any LinkedIn MCP tool, fired from the same wrapper that writes
// the linkedin_actions row (see lib/integrations/providers/linkedin-unipile/action-log.ts).
// It exists to measure adoption (which tools agents use, how often, with what outcome).
//
// Privacy contract: the properties below are the whole payload. No target id, no name, no text,
// no object or approval id ever goes in; the per-person join stays in the database, where the
// log row is. linkedin-events.test.ts asserts the exact key set, so adding a property here
// fails that test on purpose.
export const LINKEDIN_TOOL_CALLED = 'linkedin_tool_called'

export interface LinkedInToolCalledProps {
	tool: string
	kind: 'read' | 'write' | 'send'
	outcome: string
	errorCode: string | null
	actorId: string
	sessionId: string | null
	identityType: 'personal' | 'company_page'
}

/** Best-effort per capturePosthogEvent: never throws. */
export async function trackLinkedInToolCalled(p: LinkedInToolCalledProps): Promise<void> {
	await capturePosthogEvent(LINKEDIN_TOOL_CALLED, p.actorId, {
		tool: p.tool,
		kind: p.kind,
		outcome: p.outcome,
		error_code: p.errorCode,
		actor_id: p.actorId,
		session_id: p.sessionId,
		identity_type: p.identityType,
	})
}
