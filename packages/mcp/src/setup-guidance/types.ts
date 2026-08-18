/**
 * Pure-TypeScript readiness checks for loops, bets, and actors. Every check
 * function accepts a pre-fetched context and returns `SetupCheck[]` — the
 * module itself makes no API or LLM calls. Wiring (T2/T3) is responsible for
 * assembling the context under a 4-call budget.
 */

export type SetupCheckStatus = 'fail' | 'warn' | 'unknown'

export type SetupCheckFix = {
	tool: string
	args_hint: string
	why: string
}

export type SetupCheck = {
	name: string
	status: SetupCheckStatus
	message: string
	fix?: SetupCheckFix
}

/**
 * Workspace-level LLM readiness. Populated from `workspaces.settings.llm_keys`
 * (any provider entry set to a non-empty string counts) OR any legal shape of
 * `workspaces.settings.claude_oauth`. Never per-agent — that field does not
 * exist on the actor schema.
 */
export type WorkspaceLlmReadiness = {
	hasLlmKey: boolean
	hasClaudeOAuth: boolean
}

/** One loop step = one trigger + its target actor (the step agent). */
export type LoopStep = {
	triggerId: string
	triggerName?: string | null
	/** `triggers.action_prompt` — the prompt handed to the agent when the trigger fires. */
	triggerActionPrompt?: string | null
	/** Full `triggers.config` JSON — cron scope, event filter, reminder timing. */
	triggerConfig?: unknown
	/** Resolved step agent (from `triggers.target_actor_id`). `null` = no agent assigned. */
	agent: {
		id: string
		name?: string | null
		description?: string | null
	} | null
}

export type LoopCheckContext = {
	workspace: WorkspaceLlmReadiness
	/** Provider names currently connected in this workspace (e.g. `['github', 'slack']`). */
	connectedProviders: string[]
	steps: LoopStep[]
	/** Count of objects reached via `in_loop` edges — sum of open + closed. */
	memberCount: number
}

/** Minimal loop shape read by the loop check-set. */
export type LoopInput = {
	id: string
	name?: string | null
	entryCondition?: string | null
	closeCondition?: string | null
}

export type BetCheckContext = {
	workspace: WorkspaceLlmReadiness
	/** Ordered `statuses[type]` array from workspace settings — index 0 is the lowest. */
	statusOrder?: string[]
}

export type BetInput = {
	id: string
	type: string
	status?: string | null
}

export type ActorCheckContext = {
	workspace: WorkspaceLlmReadiness
}

export type ActorInput = {
	id: string
	name?: string | null
	type?: string | null
}
