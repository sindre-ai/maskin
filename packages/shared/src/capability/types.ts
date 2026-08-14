export type CapabilityLevel = 'novice' | 'apprentice' | 'practitioner' | 'expert' | 'master'

export type CapabilityDimensionKey = 'expertise' | 'skills' | 'connectors' | 'context' | 'autonomy'

export interface CapabilityDimension {
	key: CapabilityDimensionKey
	label: string
	score: number
	weight: number
	reasons: string[]
}

export interface CapabilityGap {
	action: string
	detail: string
	dimension: CapabilityDimensionKey
	toolHint?: string
}

export interface CapabilityOverall {
	score: number
	level: CapabilityLevel
}

export interface AgentCapability {
	version: 1
	overall: CapabilityOverall
	dimensions: CapabilityDimension[]
	unresolvedPlaceholders: string[]
	topGaps: CapabilityGap[]
}

export interface McpServerLike {
	type?: 'stdio' | 'http' | string
	command?: string
	args?: string[]
	env?: Record<string, string>
	url?: string
	headers?: Record<string, string>
}

export interface AgentCapabilitySnapshot {
	/** The agent's system prompt (used by the Expertise dimension). */
	systemPrompt: string | null | undefined
	/** Short human-readable description. */
	description?: string | null
	/** Raw mcpServers block from actors.tools (name → server config). */
	mcpServers?: Record<string, McpServerLike> | null
	/** Number of attached workspace skills. */
	skillCount?: number
	/** Number of attached skills that failed validation. */
	invalidSkillCount?: number
	/** Number of triggers whose target actor is this agent. */
	triggerCount?: number
	/** True when the agent is installed as part of a marketplace loop. */
	inLoop?: boolean
	/** LLM model identifier (e.g. "claude-sonnet-4-6"). */
	model?: string | null
	/** LLM provider identifier (e.g. "anthropic"). */
	llmProvider?: string | null
	/** Keys present on the actor's memory jsonb. */
	memoryKeys?: string[]
	/** Provider ids of currently-active workspace integrations. */
	activeIntegrationProviders?: string[]
	/** Env var names available to the container at runtime (from integrations + system). */
	availableEnvKeys?: string[]
}
