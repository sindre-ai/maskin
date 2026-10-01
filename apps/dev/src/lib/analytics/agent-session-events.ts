import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

interface AgentSessionStartedWithPromptProps {
	workspaceId: string
	sessionId: string
	agentId: string
	agentName: string
	systemPrompt: string
	/**
	 * Names the dispatch path that spawned this session. Present for sessions
	 * spawned by the comment-fallback resolver (`'comment_fallback'`) so
	 * PostHog queries can attribute a session to comment→dispatch vs. cron,
	 * event triggers, etc. Absent for every other path.
	 */
	triggerSource?: string
	/**
	 * `events.id` of the `commented` row that caused this session. Paired with
	 * `triggerSource` so a resolved comment can be traced end-to-end from
	 * comment → notification → session.
	 */
	sourceCommentEventId?: number
	/**
	 * G1 skills-provisioning signal — the number of workspace skills attached
	 * to `agentId` in `workspaceId` at dispatch time, resolved from the same
	 * `workspaceSkills × agentSkills` join `pullWorkspaceSkillsForAgent` reads.
	 * `undefined` on paths that don't resolve a manifest (early-return session
	 * builds, actor-deleted mid-dispatch); PostHog reads the property as absent
	 * rather than substituting a misleading zero.
	 */
	skillsAttached?: number
	/**
	 * G1 skills-provisioning signal — the number of skills the host-side
	 * stager successfully wrote to `<sessionDir>/skills/`. Emitted at session-
	 * start with the count known at that point (the local-fallback path knows
	 * it immediately from `pullWorkspaceSkillsForAgent`; the remote-dispatch
	 * path starts at 0 and the value is updated separately when agent-server
	 * reports back via `recordSkillStagingResult`). Absent when
	 * `skillsAttached` is absent, for the same reason.
	 */
	skillsStaged?: number
	/**
	 * The `triggers.type` of the trigger that dispatched this session —
	 * `'cron'`, `'event'`, or `'reminder'`. Present only for trigger-dispatched
	 * sessions; absent for comment-fallback, interactive, and API-created ones,
	 * where `triggerSource` carries the attribution instead. This is the
	 * cron-vs-event split G2 needs to segment the skill-load rate.
	 */
	triggerType?: string
	/**
	 * `triggers.id` of the dispatching trigger (the `sessions.trigger_id`
	 * column). Paired with `triggerType` so any session can be traced back to
	 * the exact trigger that fired it.
	 */
	triggerId?: string
}

/**
 * Cheap tokens-from-chars approximation (Anthropic's documented ~4-chars-per-token
 * rule of thumb). Sufficient for measuring *relative* per-agent preamble drops;
 * we ship raw char count alongside so downstream queries can sanity-check.
 */
export function approximatePromptTokens(text: string): number {
	if (text.length === 0) return 0
	return Math.ceil(text.length / 4)
}

/**
 * Fires `agent_session_started_with_prompt` once per session launch (initial
 * start or resume). Carries the agent's identity and the size of its
 * `systemPrompt` at launch, so PostHog can plot mean preamble tokens per agent
 * over time — the missing measurement gate for the "simplify agent prompts"
 * bet.
 *
 * Best-effort: any PostHog failure is swallowed so analytics can never block a
 * session launch.
 */
export async function trackAgentSessionStartedWithPrompt(
	p: AgentSessionStartedWithPromptProps,
): Promise<void> {
	try {
		const chars = p.systemPrompt.length
		const tokens = approximatePromptTokens(p.systemPrompt)
		await capturePosthogEvent('agent_session_started_with_prompt', p.agentId, {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			agent_id: p.agentId,
			agent_name: p.agentName,
			system_prompt_chars: chars,
			system_prompt_tokens: tokens,
			trigger_source: p.triggerSource,
			source_comment_event_id: p.sourceCommentEventId,
			skills_attached: p.skillsAttached,
			skills_staged: p.skillsStaged,
			trigger_type: p.triggerType,
			trigger_id: p.triggerId,
		})
	} catch (err) {
		logger.warn('Failed to emit agent_session_started_with_prompt', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}

/**
 * G1 failure signal — fires once per session when the host-side stager
 * reported one or more per-skill failures back over `POST /skill-staging`.
 * Independent from `agent_session_started_with_prompt` so a PostHog query
 * can filter to just the failure population without extracting a nested prop.
 *
 * `failureCount` is authoritative; `failureNames` is a bounded sample for
 * on-view debugging (PostHog property lengths are capped, so this is the
 * first few names, not the full list).
 *
 * Best-effort — analytics can never block session boot or the reporting
 * endpoint's 200.
 */
export async function trackSessionSkillLoadFailed(p: {
	workspaceId: string
	sessionId: string
	agentId: string
	failureCount: number
	failureNames: string[]
}): Promise<void> {
	try {
		await capturePosthogEvent('session_skill_load_failed', p.agentId, {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			agent_id: p.agentId,
			failure_count: p.failureCount,
			failure_names: p.failureNames,
		})
	} catch (err) {
		logger.warn('Failed to emit session_skill_load_failed', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}

/**
 * G1 completion signal — dev-side companion to the frontend-emitted
 * `agent_session_completed` PostHog event. Fires from
 * `session-manager`'s terminal paths (local `handleCompletion` and remote
 * `markRemoteSessionComplete`) so the same `session_id` carries the skill-
 * provisioning counts on both the start and end events, satisfying the bet's
 * G1 acceptance criterion without depending on the SSE-driven frontend
 * emission having access to fields the pg_notify payload deliberately
 * omits (see `.claude/rules/known-pitfalls.md` — PG NOTIFY payload size).
 *
 * The frontend event stays live and carries its own `outcome` prop; joining
 * on `session_id` gives PostHog queries a single ground truth. Duplicating
 * the event name is intentional and cheap — data engineering can `distinct
 * count` on session_id if a per-session view is needed.
 */
export async function trackAgentSessionCompletedWithSkills(p: {
	workspaceId: string
	sessionId: string
	agentId: string
	outcome: 'completed' | 'failed' | 'timeout'
	skillsAttached?: number
	skillsStaged?: number
}): Promise<void> {
	try {
		await capturePosthogEvent('agent_session_completed', p.agentId, {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			agent_id: p.agentId,
			outcome: p.outcome,
			skills_attached: p.skillsAttached,
			skills_staged: p.skillsStaged,
			// Distinguishes the dev-side emission from the frontend one at query
			// time. PostHog treats absent properties as null; setting this on the
			// dev-side path lets a query filter to a single source when needed.
			emitted_from: 'dev_backend',
		})
	} catch (err) {
		logger.warn('Failed to emit agent_session_completed (dev-side)', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}
