import { critiqueSystemPrompt, expertiseScoreFromCritique } from './critique'
import type {
	AgentCapability,
	AgentCapabilitySnapshot,
	CapabilityDimension,
	CapabilityDimensionKey,
	CapabilityGap,
	CapabilityLevel,
	McpServerLike,
} from './types'

interface RubricEntry {
	key: CapabilityDimensionKey
	label: string
	weight: number
}

export const CAPABILITY_RUBRIC: readonly RubricEntry[] = [
	{ key: 'expertise', label: 'Expertise', weight: 35 },
	{ key: 'skills', label: 'Skills', weight: 20 },
	{ key: 'connectors', label: 'Connectors', weight: 20 },
	{ key: 'context', label: 'Context', weight: 10 },
	{ key: 'autonomy', label: 'Autonomy', weight: 15 },
] as const

export const CAPABILITY_LEVEL_THRESHOLDS: ReadonlyArray<{
	level: CapabilityLevel
	min: number
}> = [
	{ level: 'master', min: 85 },
	{ level: 'expert', min: 65 },
	{ level: 'practitioner', min: 40 },
	{ level: 'apprentice', min: 20 },
	{ level: 'novice', min: 0 },
] as const

const MAX_DIM_SCORE = 5
const MAX_OVERALL = 100

// MCP servers named `maskin` are the workspace's own API — they don't
// count toward the Connectors dimension since every agent gets it by default.
const BASELINE_SERVER_NAME = 'maskin'

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export function levelForScore(score: number): CapabilityLevel {
	const clamped = Math.max(0, Math.min(MAX_OVERALL, score))
	for (const bucket of CAPABILITY_LEVEL_THRESHOLDS) {
		if (clamped >= bucket.min) return bucket.level
	}
	return 'novice'
}

/**
 * Extract every `${VAR}` reference from a single MCP server config's
 * env values, header values, args, url, and command. Object keys are not
 * scanned — only the values that get interpolated at container-launch time.
 */
function extractPlaceholdersFromServer(server: McpServerLike): string[] {
	const found: string[] = []
	const push = (value: string | undefined) => {
		if (typeof value !== 'string') return
		let match: RegExpExecArray | null
		PLACEHOLDER_RE.lastIndex = 0
		match = PLACEHOLDER_RE.exec(value)
		while (match) {
			const name = match[1]
			if (name) found.push(name)
			match = PLACEHOLDER_RE.exec(value)
		}
	}
	push(server.url)
	push(server.command)
	if (Array.isArray(server.args)) {
		for (const arg of server.args) push(arg)
	}
	if (server.env) {
		for (const value of Object.values(server.env)) push(value)
	}
	if (server.headers) {
		for (const value of Object.values(server.headers)) push(value)
	}
	return found
}

interface ConnectorAnalysis {
	nonBaselineCount: number
	unresolved: string[]
}

function analyzeConnectors(
	mcpServers: Record<string, McpServerLike> | null | undefined,
	availableEnvKeys: string[] | undefined,
): ConnectorAnalysis {
	if (!mcpServers) return { nonBaselineCount: 0, unresolved: [] }
	const available = new Set(availableEnvKeys ?? [])
	const unresolvedSet = new Set<string>()
	let nonBaselineCount = 0
	for (const [name, server] of Object.entries(mcpServers)) {
		if (name !== BASELINE_SERVER_NAME) nonBaselineCount += 1
		for (const placeholder of extractPlaceholdersFromServer(server)) {
			if (!available.has(placeholder)) unresolvedSet.add(placeholder)
		}
	}
	return { nonBaselineCount, unresolved: Array.from(unresolvedSet).sort() }
}

interface DimensionResult {
	score: number
	reasons: string[]
}

function scoreExpertise(snapshot: AgentCapabilitySnapshot): DimensionResult {
	const critique = critiqueSystemPrompt(snapshot.systemPrompt)
	const score = expertiseScoreFromCritique(critique)
	const reasons: string[] = []
	if (critique.isEmpty) {
		reasons.push('System prompt is empty.')
	} else {
		reasons.push(`Prompt is ${critique.length} characters.`)
		if (critique.headingCount > 0) reasons.push(`${critique.headingCount} sections detected.`)
		if (critique.hasExamples) reasons.push('Includes concrete examples.')
		if (critique.hasDecisionFramework) reasons.push('Includes a decision framework.')
		if (critique.hasStance) reasons.push('States a clear stance / role.')
		if (critique.hasOutputFormat) reasons.push('Names an output format.')
	}
	return { score, reasons }
}

function scoreSkills(snapshot: AgentCapabilitySnapshot): DimensionResult {
	const count = Math.max(0, snapshot.skillCount ?? 0)
	const invalid = Math.max(0, snapshot.invalidSkillCount ?? 0)
	let score: number
	if (count === 0) score = 0
	else if (count === 1) score = 2
	else if (count === 2) score = 3
	else if (count <= 4) score = 4
	else score = 5
	if (invalid > 0) score = Math.max(0, score - 1)
	const reasons: string[] = [
		count === 0 ? 'No skills attached.' : `${count} skill${count === 1 ? '' : 's'} attached.`,
	]
	if (invalid > 0) reasons.push(`${invalid} skill${invalid === 1 ? '' : 's'} failed validation.`)
	return { score, reasons }
}

function scoreConnectors(analysis: ConnectorAnalysis): DimensionResult {
	const { nonBaselineCount, unresolved } = analysis
	let score: number
	if (nonBaselineCount === 0) score = 0
	else if (nonBaselineCount === 1) score = 2
	else if (nonBaselineCount === 2) score = 3
	else score = 4
	if (nonBaselineCount >= 1 && unresolved.length === 0) score = Math.min(MAX_DIM_SCORE, score + 1)
	if (unresolved.length > 0) score = Math.min(score, 2)
	const reasons: string[] = []
	if (nonBaselineCount === 0) {
		reasons.push('No external MCP connectors beyond the workspace baseline.')
	} else {
		reasons.push(
			`${nonBaselineCount} external MCP connector${nonBaselineCount === 1 ? '' : 's'} configured.`,
		)
	}
	if (unresolved.length > 0) {
		reasons.push(
			`${unresolved.length} unresolved placeholder${unresolved.length === 1 ? '' : 's'}: ${unresolved.join(', ')}.`,
		)
	}
	return { score, reasons }
}

function scoreContext(snapshot: AgentCapabilitySnapshot): DimensionResult {
	const memoryKeys = snapshot.memoryKeys ?? []
	let score = 0
	const reasons: string[] = []
	if (memoryKeys.length >= 1) {
		score += 2
		reasons.push(`${memoryKeys.length} memory key${memoryKeys.length === 1 ? '' : 's'} recorded.`)
	} else {
		reasons.push('No memory keys recorded.')
	}
	if (memoryKeys.length >= 3) score += 1
	if (snapshot.description && snapshot.description.trim().length > 0) {
		score += 1
		reasons.push('One-line description set.')
	}
	if (snapshot.model && snapshot.model.trim().length > 0) {
		score += 1
		reasons.push(`Model pinned to ${snapshot.model}.`)
	}
	if (snapshot.llmProvider && snapshot.llmProvider.trim().length > 0) {
		score += 1
		reasons.push(`Provider set (${snapshot.llmProvider}).`)
	}
	return { score: Math.min(MAX_DIM_SCORE, score), reasons }
}

function scoreAutonomy(snapshot: AgentCapabilitySnapshot): DimensionResult {
	const count = Math.max(0, snapshot.triggerCount ?? 0)
	let score: number
	if (count === 0) score = 0
	else if (count === 1) score = 3
	else if (count === 2) score = 4
	else score = 5
	if (snapshot.inLoop) score = Math.max(score, 3)
	const reasons: string[] = [
		count === 0
			? 'No triggers fire this agent.'
			: `${count} trigger${count === 1 ? '' : 's'} target this agent.`,
	]
	if (snapshot.inLoop) reasons.push('Installed as part of a marketplace loop.')
	return { score, reasons }
}

interface GapSeed {
	dimension: CapabilityDimensionKey
	action: string
	detail: string
	toolHint?: string
}

function collectGaps(
	snapshot: AgentCapabilitySnapshot,
	analysis: ConnectorAnalysis,
	dimensions: CapabilityDimension[],
): CapabilityGap[] {
	const byKey = new Map(dimensions.map((d) => [d.key, d]))
	const seeds: GapSeed[] = []
	const critique = critiqueSystemPrompt(snapshot.systemPrompt)
	const expertise = byKey.get('expertise')
	if (expertise && expertise.score < 5) {
		if (critique.isEmpty || critique.length < 200) {
			seeds.push({
				dimension: 'expertise',
				action: 'Write a system prompt',
				detail:
					'The system prompt is empty or nearly empty — write at least a short role statement and what the agent should do.',
				toolHint: 'update_actor',
			})
		} else if (critique.length < 800 || critique.headingCount < 3) {
			seeds.push({
				dimension: 'expertise',
				action: 'Expand the system prompt',
				detail:
					'Add sections for role, scope, decision framework, and examples — target ≥800 characters with ≥3 headings.',
				toolHint: 'refine_agent',
			})
		} else if (!critique.hasExamples || critique.length < 2000) {
			seeds.push({
				dimension: 'expertise',
				action: 'Add concrete examples',
				detail:
					'Show at least one worked example or code fence so the agent knows the target shape of its output.',
				toolHint: 'refine_agent',
			})
		} else {
			seeds.push({
				dimension: 'expertise',
				action: 'Sharpen the decision framework',
				detail: 'Name the stepwise procedure or stance the agent should follow.',
				toolHint: 'refine_agent',
			})
		}
	}
	const skills = byKey.get('skills')
	if (skills && skills.score < 5) {
		const count = snapshot.skillCount ?? 0
		if (count === 0) {
			seeds.push({
				dimension: 'skills',
				action: 'Attach a skill',
				detail: 'Skills give the agent step-by-step methods it can invoke by name.',
				toolHint: 'create_workspace_skill',
			})
		} else if ((snapshot.invalidSkillCount ?? 0) > 0) {
			seeds.push({
				dimension: 'skills',
				action: 'Fix invalid skills',
				detail: `${snapshot.invalidSkillCount} attached skill(s) failed validation — repair their SKILL.md frontmatter.`,
				toolHint: 'update_workspace_skill',
			})
		} else if (count < 3) {
			seeds.push({
				dimension: 'skills',
				action: 'Attach more skills',
				detail: 'Reach 3+ skills so the agent can handle a range of tasks.',
				toolHint: 'create_workspace_skill',
			})
		}
	}
	const connectors = byKey.get('connectors')
	if (connectors && connectors.score < 5) {
		if (analysis.unresolved.length > 0) {
			seeds.push({
				dimension: 'connectors',
				action: 'Connect a missing integration',
				detail: `Values ${analysis.unresolved.join(', ')} are not available at launch — connect the owning integration or set the env var.`,
				toolHint: 'connect_integration',
			})
		} else if (analysis.nonBaselineCount === 0) {
			seeds.push({
				dimension: 'connectors',
				action: 'Add an MCP connector',
				detail:
					'Attach at least one external MCP server so the agent can act outside the workspace.',
				toolHint: 'update_actor',
			})
		} else if (analysis.nonBaselineCount < 3) {
			seeds.push({
				dimension: 'connectors',
				action: 'Broaden the connector set',
				detail: 'Add another MCP connector (github, slack, exa, playwright, …) to expand reach.',
				toolHint: 'update_actor',
			})
		}
	}
	const context = byKey.get('context')
	if (context && context.score < 5) {
		if (!snapshot.description || snapshot.description.trim().length === 0) {
			seeds.push({
				dimension: 'context',
				action: 'Add a one-line description',
				detail:
					'A short description helps humans (and other agents) recognise this agent at a glance.',
				toolHint: 'update_actor',
			})
		} else if ((snapshot.memoryKeys ?? []).length === 0) {
			seeds.push({
				dimension: 'context',
				action: 'Seed the agent memory',
				detail: 'Record durable facts the agent should recall across sessions.',
				toolHint: 'update_actor',
			})
		} else if (!snapshot.model) {
			seeds.push({
				dimension: 'context',
				action: 'Pin an LLM model',
				detail: 'Choose the model this agent should run on so behaviour stays predictable.',
				toolHint: 'update_actor',
			})
		}
	}
	const autonomy = byKey.get('autonomy')
	if (autonomy && autonomy.score < 5) {
		const count = snapshot.triggerCount ?? 0
		if (count === 0) {
			seeds.push({
				dimension: 'autonomy',
				action: 'Create a trigger',
				detail: 'Wire an event or cron trigger so the agent runs itself.',
				toolHint: 'create_trigger',
			})
		} else if (count < 3) {
			seeds.push({
				dimension: 'autonomy',
				action: 'Add another trigger',
				detail:
					'A second trigger lets the agent respond to more than one kind of workspace signal.',
				toolHint: 'create_trigger',
			})
		}
	}

	// Rank by rubric weight × remaining headroom, so the highest-leverage
	// upgrade lands first. Stable insertion order breaks ties.
	const withPriority = seeds.map((seed, index) => {
		const dim = byKey.get(seed.dimension)
		const headroom = dim ? MAX_DIM_SCORE - dim.score : MAX_DIM_SCORE
		const weight = dim ? dim.weight : 0
		return { seed, index, priority: weight * headroom }
	})
	withPriority.sort((a, b) => {
		if (b.priority !== a.priority) return b.priority - a.priority
		return a.index - b.index
	})
	return withPriority.slice(0, 5).map(({ seed }) => ({
		action: seed.action,
		detail: seed.detail,
		dimension: seed.dimension,
		...(seed.toolHint ? { toolHint: seed.toolHint } : {}),
	}))
}

/**
 * Compute the capability rating for an agent given a deterministic snapshot
 * of its authored state and workspace-scoped context. Pure — no DB queries,
 * no LLM calls, no I/O. Same inputs always produce the same output.
 */
export function scoreAgentCapability(snapshot: AgentCapabilitySnapshot): AgentCapability {
	const analysis = analyzeConnectors(snapshot.mcpServers, snapshot.availableEnvKeys)
	const perDim: Record<CapabilityDimensionKey, DimensionResult> = {
		expertise: scoreExpertise(snapshot),
		skills: scoreSkills(snapshot),
		connectors: scoreConnectors(analysis),
		context: scoreContext(snapshot),
		autonomy: scoreAutonomy(snapshot),
	}
	const dimensions: CapabilityDimension[] = CAPABILITY_RUBRIC.map((entry) => {
		const result = perDim[entry.key]
		return {
			key: entry.key,
			label: entry.label,
			score: Math.max(0, Math.min(MAX_DIM_SCORE, result.score)),
			weight: entry.weight,
			reasons: result.reasons,
		}
	})
	const overallScore = Math.round(
		dimensions.reduce((sum, dim) => sum + (dim.score / MAX_DIM_SCORE) * dim.weight, 0),
	)
	const topGaps = collectGaps(snapshot, analysis, dimensions)
	return {
		version: 1,
		overall: {
			score: overallScore,
			level: levelForScore(overallScore),
		},
		dimensions,
		unresolvedPlaceholders: analysis.unresolved,
		topGaps,
	}
}
