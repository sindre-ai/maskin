export type CapabilityDimensionKey = 'expertise' | 'skills' | 'connectors' | 'context' | 'autonomy'

export type CapabilityLevel = 'novice' | 'apprentice' | 'practitioner' | 'expert' | 'master'

export type CapabilityScore = 0 | 1 | 2 | 3 | 4 | 5

/**
 * Everything the scorer needs to rate an agent, gathered by the caller.
 * The scorer stays ignorant of where the data comes from so it can run
 * against a live actor row, a builder preview, or a test fixture alike.
 */
export interface AgentCapabilitySnapshot {
	systemPrompt: string | null
	description: string | null
	/** The actor's `tools.mcpServers` map. The `maskin` platform preset is excluded from scoring. */
	mcpServers: Record<string, unknown>
	skillCount: number
	/** Attached skills whose workspace_skills row has isValid = false. */
	invalidSkillCount: number
	/** Triggers whose target_actor_id is this agent. */
	triggerCount: number
	/** True when the agent was installed as part of a loop (metadata.installed_loop_id). */
	inLoop: boolean
	model: string | null
	llmProvider: string | null
	/** Object.keys(actor.memory ?? {}).length */
	memoryKeys: number
	/** Providers with an active integration row in the agent's workspace, e.g. ['github', 'slack']. */
	activeIntegrationProviders: string[]
	/** Env var names the session runtime will inject for this workspace (MASKIN_*, provider tokens, …). */
	availableEnvKeys: string[]
}

export type CapabilityGapAction =
	| 'expand_system_prompt'
	| 'add_structure'
	| 'add_stance'
	| 'add_examples'
	| 'add_description'
	| 'attach_skill'
	| 'add_mcp_server'
	| 'connect_integration'
	| 'fix_placeholder'
	| 'add_trigger'
	| 'seed_memory'
	| 'set_model'

export interface CapabilityGap {
	action: CapabilityGapAction
	detail: string
	/** MCP tool that closes this gap, e.g. 'update_actor', 'create_trigger', 'connect_integration'. */
	toolHint?: string
}

export interface CapabilityDimension {
	key: CapabilityDimensionKey
	label: string
	score: CapabilityScore
	reasons: string[]
	gaps: CapabilityGap[]
}

/** A `${VAR}` in an MCP server spec that no runtime-injected env var will resolve. */
export interface UnresolvedPlaceholder {
	server: string
	envKey: string
	placeholder: string
}

export interface AgentCapability {
	version: 1
	overall: { score: number; level: CapabilityLevel }
	/** Always all 5 dimensions, in rubric order. */
	dimensions: CapabilityDimension[]
	unresolvedPlaceholders: UnresolvedPlaceholder[]
	/** ≤5 highest-impact gaps across all dimensions, ordered by weight × headroom. */
	topGaps: CapabilityGap[]
}

export type PromptCriterionId =
	| 'role_identity'
	| 'scope_boundaries'
	| 'decision_framework'
	| 'stance'
	| 'examples'
	| 'output_format'
	| 'structure'
	| 'length'

/** One producer-critic rubric verdict. `detail` is a concrete revision instruction on failure. */
export interface PromptCriterion {
	id: PromptCriterionId
	pass: boolean
	detail: string
}
