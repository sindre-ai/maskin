import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Canonical event names for the Workspace Skills bet ship metric. Both events
// are the answer to "the manual E2E was unmeasurable" — attached tracks reach
// (a workspace picked up shared skills at all), loaded tracks whether an
// agent session actually pulled one down. Kept as constants so downstream
// PostHog / HogQL callers can import the same string.
export const WORKSPACE_SKILL_ATTACHED = 'workspace_skill_attached'
export const WORKSPACE_SKILL_LOADED = 'workspace_skill_loaded'

export type SkillAttachSource = 'ui' | 'mcp'

interface WorkspaceSkillAttachedProps {
	workspaceId: string
	// The caller / acting user. Same semantics as the PostHog super-property
	// `actor_id` — never rebound here.
	actorId: string
	// The agent (actor of type=agent) the skill was attached to.
	agentActorId: string
	skillName: string
	via: SkillAttachSource
	// Whether the SKILL.md parsed cleanly and will be pulled into agent sessions.
	// Optional so the emitter stays backwards-compatible with any caller that
	// hasn't loaded the row's `isValid` yet — the Overhaul Skills UX bet segments
	// on this to see "attached but not usable" outcomes.
	skillVisible?: boolean
}

interface WorkspaceSkillLoadedProps {
	workspaceId: string
	agentActorId: string
	skillName: string
	// The session that pulled the skill onto disk. Absent when a pull happens
	// outside a session context (there is no such call site today, but the
	// prop is nullable so future callers don't lie).
	sessionId: string | null
}

// Fire-and-forget — analytics must never surface to the caller.
// `distinct_id` is the workspace so the ship-metric HogQL can COUNT DISTINCT
// on workspaces without needing a JOIN to `properties.workspace_id`.
export async function trackWorkspaceSkillAttached(p: WorkspaceSkillAttachedProps): Promise<void> {
	try {
		await capturePosthogEvent(WORKSPACE_SKILL_ATTACHED, p.workspaceId, {
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
			agent_actor_id: p.agentActorId,
			skill_name: p.skillName,
			via: p.via,
			...(p.skillVisible !== undefined && { skill_visible: p.skillVisible }),
		})
	} catch (err) {
		logger.warn('workspace_skill_attached capture failed', {
			workspaceId: p.workspaceId,
			agentActorId: p.agentActorId,
			skillName: p.skillName,
			error: String(err),
		})
	}
}

export async function trackWorkspaceSkillLoaded(p: WorkspaceSkillLoadedProps): Promise<void> {
	try {
		await capturePosthogEvent(WORKSPACE_SKILL_LOADED, p.workspaceId, {
			workspace_id: p.workspaceId,
			agent_actor_id: p.agentActorId,
			skill_name: p.skillName,
			session_id: p.sessionId,
		})
	} catch (err) {
		logger.warn('workspace_skill_loaded capture failed', {
			workspaceId: p.workspaceId,
			agentActorId: p.agentActorId,
			skillName: p.skillName,
			error: String(err),
		})
	}
}
