import { logger } from '../logger'
import type { StartPromptSize } from './first-call-size'
import { capturePosthogEvent } from './posthog'

/** Persona prompt size that gets a warning in the log (the CTO's number). Warn only, nothing is cut. */
export const PERSONA_PROMPT_WARN_BYTES = 30 * 1024
/** Whole start prompt size that gets a warning in the log (the CTO's number). Warn only, nothing is cut. */
export const START_PROMPT_WARN_BYTES = 100 * 1024

interface AgentSessionStartedWithPromptProps {
	workspaceId: string
	sessionId: string
	agentId: string
	agentName: string
	systemPrompt: string
	/**
	 * `sessions.sourceSessionId` — non-null when the session was spawned by
	 * another session (sub-agent delegation). Ridden onto every emission as
	 * `source_session_id` so PostHog can isolate spawn events from top-level
	 * starts with `WHERE source_session_id IS NOT NULL`.
	 */
	sourceSessionId?: string | null
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
	/**
	 * When the launch happened. Becomes the event's timestamp, so an event that is
	 * sent later (at the first turn result, or at the end of a launch that had no
	 * turn) still lands at launch time and the prompt-size and skills charts do not
	 * shift. Defaults to now.
	 */
	launchedAt?: Date
	/**
	 * What the first turn showed, for the session-start baseline of the "smaller
	 * agent context" bet. Absent on a launch that ended before any turn: the four
	 * properties are then left off the event, which PostHog reads as empty.
	 */
	firstCall?: {
		toolCount: number | null
		/**
		 * Input tokens + cache creation tokens + cache read tokens of the first
		 * model call. Never the bare input-token count, which leaves out cache
		 * reads and would make a cache change look like a win.
		 */
		firstCallInputTokens: number | null
		/** Cost of the first turn in USD, priced for the route the session ran on. */
		firstTurnCostUsd: number | null
		/** Whether the first call read from the prompt cache. */
		cacheHit: boolean | null
	}
	/**
	 * The start prompt sizes agent-run.sh reported. Rides on the event as
	 * `learnings_bytes` and `learnings_capped`, and drives the oversized-prompt
	 * warnings. Absent when the launch ended before the line was read.
	 */
	startPrompt?: StartPromptSize | null
}

/** One log line per oversized start, naming the agent and the size. The prompt is not changed. */
function warnOversizedStartPrompt(p: AgentSessionStartedWithPromptProps, size: StartPromptSize) {
	if (size.personaBytes > PERSONA_PROMPT_WARN_BYTES) {
		logger.warn('Agent persona prompt is very large', {
			agentId: p.agentId,
			agentName: p.agentName,
			sessionId: p.sessionId,
			personaBytes: size.personaBytes,
			warnAtBytes: PERSONA_PROMPT_WARN_BYTES,
		})
	}
	if (size.totalBytes > START_PROMPT_WARN_BYTES) {
		logger.warn('Agent start prompt is very large', {
			agentId: p.agentId,
			agentName: p.agentName,
			sessionId: p.sessionId,
			totalBytes: size.totalBytes,
			warnAtBytes: START_PROMPT_WARN_BYTES,
		})
	}
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
 * bet. It also carries the size of the first call (`tool_count`,
 * `first_call_input_tokens`, `first_turn_cost`, `cache_hit`), which only exists
 * once the first turn has run: the session manager sends the event then, or at
 * the end of the launch with those four left empty, and `launchedAt` keeps the
 * timestamp at launch either way.
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
		if (p.startPrompt) warnOversizedStartPrompt(p, p.startPrompt)
		await capturePosthogEvent(
			'agent_session_started_with_prompt',
			p.agentId,
			{
				workspace_id: p.workspaceId,
				session_id: p.sessionId,
				agent_id: p.agentId,
				agent_name: p.agentName,
				system_prompt_chars: chars,
				system_prompt_tokens: tokens,
				source_session_id: p.sourceSessionId ?? null,
				trigger_source: p.triggerSource,
				source_comment_event_id: p.sourceCommentEventId,
				skills_attached: p.skillsAttached,
				skills_staged: p.skillsStaged,
				trigger_type: p.triggerType,
				trigger_id: p.triggerId,
				tool_count: p.firstCall?.toolCount ?? undefined,
				first_call_input_tokens: p.firstCall?.firstCallInputTokens ?? undefined,
				first_turn_cost: p.firstCall?.firstTurnCostUsd ?? undefined,
				cache_hit: p.firstCall?.cacheHit ?? undefined,
				learnings_bytes: p.startPrompt?.learningsBytes,
				learnings_capped: p.startPrompt?.learningsCapped,
			},
			{ timestamp: p.launchedAt },
		)
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
 * Which model ran, and why: `model` is the one the session launched on,
 * `model_source` says whether it came from the agent's own setting, the tier
 * default or workspace config, and `route` is the LLM route that serves it.
 * These three ride on `agent_session_started`, `trigger_fired` (for a
 * trigger-dispatched session) and `agent_session_completed`, and `model`
 * equals the `$ai_model` on the session's generation event.
 */
export interface SessionModelProps {
	model: string | null
	modelSource: string | null
	route: string | null
}

/**
 * Dev-side `agent_session_started` and, for a trigger-dispatched session,
 * `trigger_fired`, fired once when a session first launches with its model
 * resolved. A resume keeps the model it started on and does not fire again.
 * The web app still emits `agent_session_started` from the browser, and
 * `emitted_from` tells the two apart. It no longer sends `trigger_fired`, so
 * the dev-side one is the only copy.
 *
 * Best-effort — analytics can never block a launch.
 */
export async function trackSessionLaunchModel(
	p: SessionModelProps & {
		workspaceId: string
		sessionId: string
		agentId: string
		triggerId?: string | null
		triggerType?: string | null
	},
): Promise<void> {
	try {
		const base = {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			agent_id: p.agentId,
			model: p.model,
			model_source: p.modelSource,
			route: p.route,
			emitted_from: 'dev_backend',
		}
		await capturePosthogEvent('agent_session_started', p.agentId, base)
		if (p.triggerId) {
			await capturePosthogEvent('trigger_fired', p.agentId, {
				...base,
				trigger_id: p.triggerId,
				trigger_type: p.triggerType ?? null,
			})
		}
	} catch (err) {
		logger.warn('Failed to emit agent_session_started (dev-side)', {
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
	modelProps?: SessionModelProps
	/** Wall-clock run time; absent when the session has no start time on record. */
	durationMs?: number
}): Promise<void> {
	try {
		await capturePosthogEvent('agent_session_completed', p.agentId, {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			agent_id: p.agentId,
			outcome: p.outcome,
			skills_attached: p.skillsAttached,
			skills_staged: p.skillsStaged,
			model: p.modelProps?.model ?? null,
			model_source: p.modelProps?.modelSource ?? null,
			route: p.modelProps?.route ?? null,
			duration_ms: p.durationMs,
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
